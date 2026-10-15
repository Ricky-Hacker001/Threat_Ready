import { useState } from 'react';
import { useDraft } from '../../state/ui';
import { CheckCircle2, Download, HardDriveDownload, History, Trash2 } from 'lucide-react';
import { useStore } from '../../state/store';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Section, Tabs } from '../../components/ui';
import { createBackup, deleteBackup, exportFile, restoreBackup } from '../../services/deviceService';

type Tab = 'backups' | 'settings';

export function FirmwarePage() {
  const { config, session, commit, addAudit, patchSession, emit } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('backups');
  const [create, setCreate] = useState(false);
  const [restore, setRestore] = useState<string | null>(null);
  const [del, setDel] = useState<string | null>(null);

  const doExport = () => {
    const f = exportFile(config);
    const url = URL.createObjectURL(new Blob([f.body], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    addAudit([{ category: 'System', action: 'Configuration exported', detail: f.name }]);
    emit('export', { name: f.name });
    toast(<>Lab configuration exported as <b>{f.name}</b>.</>);
  };

  const fmt = (t: number) => new Date(t).toLocaleString();

  return (
    <div className="tw-page">
      <Tabs<Tab> tabs={[{ id: 'backups', label: 'Firmware & Local Backups' }, { id: 'settings', label: 'Settings' }]} value={tab} onChange={setTab} />
      {tab === 'backups' ? (
        <>
          <div className="tw-toolbar">
            <span className="muted">Back up before every change. A local backup restores in seconds; the export keeps a copy off the appliance.</span>
            <span className="spacer" />
            <button className="tw-tool" data-guide="create-backup" onClick={() => setCreate(true)}><HardDriveDownload size={15} /> Create Backup</button>
            <button className="tw-tool" data-guide="export-config" onClick={doExport}><Download size={15} /> Export Configuration</button>
          </div>
          <div className="tw-table-wrap">
            <table className="tw-table" aria-label="Firmware and backups">
              <thead><tr><th>#</th><th>Firmware Version</th><th>Configuration Date</th><th>Username</th><th>Comments</th><th>Backup Type</th><th>Actions</th></tr></thead>
              <tbody>
                <tr>
                  <td>1</td>
                  <td>Current Firmware Version <CheckCircle2 size={13} color="var(--tw-ok)" style={{ verticalAlign: -2 }} /><div className="muted">{config.system.firmware}</div></td>
                  <td>{fmt(Date.now())}</td><td>System</td><td>This is the current firmware.</td><td>—</td><td />
                </tr>
                {config.backups.map((b, i) => (
                  <tr key={b.id}>
                    <td>{i + 2}</td>
                    <td>Backup created with version<div className="muted">{b.firmware}</div></td>
                    <td>{fmt(b.createdAt)}</td>
                    <td>{b.user}</td>
                    <td>{b.comment}</td>
                    <td>Local</td>
                    <td>
                      <button className="tw-rowbtn" title="Restore this backup" aria-label={`Restore ${b.comment}`} onClick={() => setRestore(b.id)}><History size={15} /></button>
                      <button className="tw-rowbtn" title="Delete" aria-label={`Delete ${b.comment}`} onClick={() => setDel(b.id)}><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="tw-table-foot">Total: {config.backups.length + 1} item(s)</div>
        </>
      ) : (
        <Section title="Firmware Settings">
          <div className="tw-form">
            <Row label="Current Firmware"><span className="val">{config.system.firmware}</span></Row>
            <Row label="ROM Version"><span className="val">{config.system.romVersion}</span></Row>
            <Row label="Automatic firmware check"><span className="val">{config.licensing.registered ? 'Enabled (simulated)' : 'Requires registration (task 0.5)'}</span></Row>
            <Row label="Firmware review" hint="Compare the running version with the vendor advisories before every audit.">
              <span className="val">{config.system.firmwareReviewed ? 'Reviewed: 7.1.2-7019 is the current recommended release; no open advisory applies (lab feed).' : 'Not reviewed'}</span>
              <button className="tw-btn" data-guide="fw-check" onClick={() => { commit({ ...config, system: { ...config.system, firmwareReviewed: true } }, [{ category: 'System', action: 'Firmware reviewed against advisories', detail: `${config.system.firmware} is current (lab advisory feed)` }]); toast('Firmware is current. No applicable advisories.'); }}>Check for updates</button>
            </Row>
            <Row label="Scheduled configuration export" htmlFor="fw-sched" hint="Keeps an off-box copy of the configuration.">
              <select id="fw-sched" data-guide="fw-sched" className="tw-select" value={config.system.backupSchedule} onChange={(e) => commit({ ...config, system: { ...config.system, backupSchedule: e.target.value as 'none' | 'weekly' } }, [{ category: 'System', action: 'Scheduled configuration export modified', detail: e.target.value === 'weekly' ? 'Weekly, Sunday 02:00' : 'Off' }])}>
                <option value="none">Off</option><option value="weekly">Weekly (Sunday 02:00)</option>
              </select>
            </Row>
          </div>
        </Section>
      )}

      {create && <CreateDialog onClose={() => setCreate(false)} onCreate={(c) => { const r = createBackup(config, session.user ?? 'admin', c); commit(r.next, r.audit); setCreate(false); toast('Local backup created.'); }} />}
      {restore && (
        <Confirm title="Restore configuration" danger confirmLabel="Restore and restart"
          message="The appliance loads this backup and restarts. You will be logged out and the current unsaved state is replaced."
          onCancel={() => setRestore(null)}
          onConfirm={() => {
            const r = restoreBackup(config, restore);
            setRestore(null);
            if (!r) return;
            commit(r.next, r.audit);
            const x0 = r.next.interfaces.find((i) => i.name === session.connectedVia);
            patchSession({ loggedIn: false, user: null, connectedIp: x0?.ip ?? session.connectedIp, certAccepted: false });
          }} />
      )}
      {del && <Confirm title="Delete backup" danger confirmLabel="Delete" message="This local backup will be removed." onCancel={() => setDel(null)}
        onConfirm={() => { const r = deleteBackup(config, del); commit(r.next, r.audit); setDel(null); toast('Backup deleted.'); }} />}
    </div>
  );
}

function CreateDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (comment: string) => void }) {
  const [c, setC] = useState(`Before changes ${new Date().toLocaleDateString()}`);
  useDraft('backup', { comment: c });
  return (
    <Dialog title="Create Backup" onClose={onClose} size="sm" footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="backup-create" onClick={() => onCreate(c.trim())}>Create</button>
    </>}>
      <div className="tw-form" style={{ gridTemplateColumns: '110px 1fr', paddingTop: 14 }}>
        <Row label="Comment" htmlFor="bk-c"><input id="bk-c" className="tw-input wide" value={c} onChange={(e) => setC(e.target.value)} maxLength={60} /></Row>
      </div>
    </Dialog>
  );
}
