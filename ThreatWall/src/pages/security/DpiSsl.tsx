import { useEffect, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import type { SecurityConfig } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Dialog, Note, Row, Section, Tabs, Toggle } from '../../components/ui';
import { CFS_CATEGORIES } from '../../engine/world';
import { saveDpi } from '../../services/securityService';
import { importCertificate } from '../../services/vpnService';
import { LicenseNote } from './ContentFilter';

type Tab = 'general' | 'objects';
export function DpiClientPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const saved = JSON.stringify(config.security.dpiSsl);
  const [d, setD] = useState<SecurityConfig['dpiSsl']>(() => JSON.parse(saved));
  const [names, setNames] = useState(config.security.dpiSsl.excludedNames.join('\n'));
  const [tab, setTab] = useState<Tab>('general');
  useEffect(() => { const x = JSON.parse(saved); setD(x); setNames(x.excludedNames.join('\n')); }, [saved]);
  const cur = { ...d, excludedNames: names.split(/[\n,]/).map((x) => x.trim().toLowerCase()).filter(Boolean) };
  useDraft('dpi', cur);
  const dirty = JSON.stringify(cur) !== saved;
  return (
    <div className="tw-page">
      <LicenseNote id="dpissl" name="DPI-SSL" />
      <Tabs<Tab> tabs={[{ id: 'general', label: 'General' }, { id: 'objects', label: 'Objects (exclusions)' }]} value={tab} onChange={setTab} />
      {tab === 'general' ? (
        <>
          <Section title="Client DPI-SSL">
            <div className="tw-form">
              <Row label="Enable SSL Client Inspection" hint="Decrypts HTTPS from LAN clients to the internet so IPS, anti-virus, App Control and CFS can see inside."><Toggle id="dpi-enable" checked={d.clientEnabled} onChange={(v) => setD({ ...d, clientEnabled: v })} label="Enable SSL client inspection" /></Row>
              {(['ips', 'gav', 'spyware', 'appControl', 'cfs'] as const).map((k) => (
                <Row key={k} label={`Inspect ${{ ips: 'Intrusion Prevention', gav: 'Gateway Anti-Virus', spyware: 'Gateway Anti-Spyware', appControl: 'App Control', cfs: 'Content Filter' }[k]}`}>
                  <Toggle id={`dpi-${k}`} checked={d.inspect[k]} onChange={(v) => setD({ ...d, inspect: { ...d.inspect, [k]: v } })} label={`Inspect ${k}`} />
                </Row>
              ))}
              <Row label="Always authenticate server for decrypted connections"><Toggle checked={d.alwaysAuthServer} onChange={(v) => setD({ ...d, alwaysAuthServer: v })} label="Always authenticate server" /></Row>
              <Row label="Re-signing certificate"><span className="val">ThreatWall DPI-SSL CA (export it from DEVICE › Certificates and deploy it to clients)</span></Row>
            </div>
          </Section>
          <Note kind="warn">Clients that do not trust the re-signing CA will see certificate errors on every HTTPS site. Deploy the CA first.</Note>
        </>
      ) : (
        <>
          <Section title="Exclude by category">
            <div className="tw-catgrid" id="dpi-cats">
              {CFS_CATEGORIES.map((c) => <label key={c}><input type="checkbox" data-guide={`dpicat:${c}`} checked={d.excludedCategories.includes(c)} onChange={(ev) => setD({ ...d, excludedCategories: ev.target.checked ? [...d.excludedCategories, c] : d.excludedCategories.filter((x) => x !== c) })} /> {c}</label>)}
            </div>
            <Note kind="info">Banking and health sites are excluded for privacy and legal reasons — decrypting them can breach regulations and employee privacy.</Note>
          </Section>
          <Section title="Exclude by common name (one per line)">
            <div className="tw-form"><Row label="Common names" htmlFor="dpi-names" hint="Apps that pin their certificate break under inspection — exclude them."><textarea id="dpi-names" className="tw-textarea" rows={3} value={names} onChange={(e) => setNames(e.target.value)} placeholder="pinned-app.example" /></Row></div>
          </Section>
        </>
      )}
      <div className="tw-actionbar">
        <button className="tw-btn" disabled={!dirty} onClick={() => { const x = JSON.parse(saved); setD(x); setNames(x.excludedNames.join('\n')); }}>Cancel</button>
        <button className="tw-btn tw-btn-primary" data-guide="accept" disabled={!dirty} onClick={() => { const r = saveDpi(config, cur); commit(r.next, r.audit); toast('DPI-SSL settings saved.'); }}>Accept</button>
      </div>
    </div>
  );
}

export function DpiServerPage() {
  return (
    <div className="tw-page">
      <Note kind="info">Server DPI-SSL inspects HTTPS coming <b>in</b> to your own published servers (for example WEB-01) using that server’s certificate and key. This lab’s track covers client DPI-SSL (task 3.2); server inspection is shown for completeness and is not enabled.</Note>
    </div>
  );
}

export function CertificatesPage() {
  const { config, commit, emit, addAudit } = useStore();
  const toast = useToast();
  const [imp, setImp] = useState(false);
  const exportCa = (name: string) => {
    const body = `-----BEGIN CERTIFICATE-----\n(ThreatWall lab training certificate: ${name}. Not a real certificate.)\n-----END CERTIFICATE-----\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'application/x-pem-file' }));
    const a = document.createElement('a'); a.href = url; a.download = `${name.replace(/\W+/g, '_')}.pem`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    addAudit([{ category: 'System', action: `Certificate ${name} exported`, detail: 'PEM (lab)' }]);
    emit('cert-export', { name });
    toast(<>Exported <b>{name}</b>. Deploy it with Lab Tools › Lab Controls › “Push to PCs”.</>);
  };
  return (
    <div className="tw-page">
      <div className="tw-toolbar"><span className="spacer" /><button className="tw-tool" data-guide="cert-import" onClick={() => setImp(true)}><Upload size={14} /> Import</button></div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Certificates">
          <thead><tr><th>Name</th><th>Type</th><th>Subject</th><th>Issuer</th><th>Expires</th><th>In use</th><th>Export</th></tr></thead>
          <tbody>{config.certificates.map((c) => <tr key={c.name} data-guide={`cert:${c.name}`}><td><b>{c.name}</b></td><td>{c.type}</td><td className="mono">{c.subject}</td><td>{c.issuer}</td><td>{c.expires}</td>
            <td>{config.system.certificate === c.name ? <span className="tw-pill ok">HTTPS management</span> : c.name.includes('DPI-SSL') ? <span className="tw-pill info">DPI-SSL re-signing</span> : ''}</td>
            <td><button className="tw-rowbtn" data-guide={`cert-export:${c.name}`} aria-label={`Export ${c.name}`} onClick={() => exportCa(c.name)}><Download size={15} /></button></td></tr>)}</tbody>
        </table>
      </div>
      {imp && <ImportDialog onClose={() => setImp(false)} onImport={(n, sub) => { const r = importCertificate(config, n, sub); commit(r.next, r.audit); setImp(false); toast(<>Imported <b>{n}</b>.</>); }} />}
    </div>
  );
}

function ImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (name: string, subject: string) => void }) {
  const { config } = useStore();
  const [name, setName] = useState('KGI-HQ-FW management');
  const [cn, setCn] = useState(config.system.hostname.toLowerCase() + '.kgi.example');
  useDraft('certimport', { name, cn });
  return (
    <Dialog title="Import Certificate (lab)" size="sm" onClose={onClose} footer={<><button className="tw-btn" onClick={onClose}>Cancel</button><button className="tw-btn tw-btn-primary" data-guide="certimport-ok" disabled={!name.trim() || !cn.trim()} onClick={() => onImport(name.trim(), `CN=${cn.trim()}`)}>Import</button></>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Certificate name" htmlFor="ci-name"><input id="ci-name" className="tw-input wide" value={name} onChange={(e) => setName(e.target.value)} /></Row>
        <Row label="Common name (CN)" htmlFor="ci-cn"><input id="ci-cn" className="tw-input wide mono" value={cn} onChange={(e) => setCn(e.target.value)} /></Row>
      </div>
      <Note kind="info">Lab simulation: this represents importing a PKCS#12 issued by your internal CA. No file or private key is needed or stored.</Note>
    </Dialog>
  );
}
