import { useState } from 'react';
import { useDraft } from '../../state/ui';
import { RefreshCw } from 'lucide-react';
import { useStore } from '../../state/store';
import { useToast } from '../../components/Toast';
import { Dialog, Note, Row, Section, SimTag } from '../../components/ui';
import { register, validateRegistration } from '../../services/deviceService';

export function LicensesPage() {
  const { config, commit, addAudit } = useStore();
  const toast = useToast();
  const lic = config.licensing;
  const [open, setOpen] = useState(false);

  return (
    <div className="tw-page">
      <Section title="Security Services Summary">
        <div className="tw-form">
          <Row label="Serial Number"><span className="val mono">{config.system.serial}</span></Row>
          <Row label="Authentication Code"><span className="val mono">{config.system.authCode}</span></Row>
          <Row label="Registration Status">
            {lic.registered
              ? <span className="tw-pill ok">Registered to {lic.account}</span>
              : <span className="tw-pill bad">Not registered</span>}
            <SimTag>Simulated portal</SimTag>
          </Row>
          <Row label="">
            {lic.registered
              ? <button className="tw-btn" onClick={() => { addAudit([{ category: 'System', action: 'Licenses synchronized', detail: 'No changes' }]); toast('Licenses synchronized with the portal.'); }}><RefreshCw size={12} style={{ verticalAlign: -1 }} /> Synchronize</button>
              : <button className="tw-btn tw-btn-primary" data-guide="register" onClick={() => setOpen(true)}>Register</button>}
          </Row>
        </div>
        {!lic.registered ? <Note kind="warn">Unregistered appliances are basic stateful firewalls: no firmware updates and no security services (content filtering, IPS, anti-virus, App Control).</Note> : null}
      </Section>

      <Section title="Licenses">
        <div className="tw-table-wrap" style={{ margin: '0 0 10px' }}>
          <table className="tw-table" aria-label="Licensed services">
            <thead><tr><th>Security Service</th><th>Status</th><th>Expiration</th></tr></thead>
            <tbody>
              {lic.services.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.status === 'licensed' ? <span className="tw-pill ok">Licensed</span> : <span className="tw-pill muted">Not Licensed</span>}</td>
                  <td>{s.expires ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {open && <RegisterDialog onClose={() => setOpen(false)} onDone={(email) => {
        const r = register(config, email);
        commit(r.next, r.audit);
        setOpen(false);
        toast('Appliance registered. All security services are licensed.');
      }} />}
    </div>
  );
}

function RegisterDialog({ onClose, onDone }: { onClose: () => void; onDone: (email: string) => void }) {
  const { config } = useStore();
  const [f, setF] = useState({ email: '', serial: '', authCode: '' });
  const [tried, setTried] = useState(false);
  const errors = validateRegistration(config, f);
  useDraft('register', f);
  const e = tried ? errors : {};
  return (
    <Dialog title="Register appliance" onClose={onClose} size="sm" footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="register-submit" onClick={() => { setTried(true); if (!Object.keys(errors).length) onDone(f.email.trim()); }}>Register</button>
    </>}>
      <Note kind="info">Simulated licensing portal. Copy the serial number and authentication code from HOME | Dashboard, as you would on real hardware.</Note>
      <div className="tw-form" style={{ gridTemplateColumns: '170px 1fr' }}>
        <Row label="Portal account email" htmlFor="rg-email" error={e.email}>
          <input id="rg-email" className={`tw-input wide${e.email ? ' invalid' : ''}`} value={f.email} onChange={(ev) => setF({ ...f, email: ev.target.value })} />
        </Row>
        <Row label="Serial Number" htmlFor="rg-serial" error={e.serial}>
          <input id="rg-serial" className={`tw-input mono${e.serial ? ' invalid' : ''}`} value={f.serial} onChange={(ev) => setF({ ...f, serial: ev.target.value })} />
        </Row>
        <Row label="Authentication Code" htmlFor="rg-auth" error={e.authCode}>
          <input id="rg-auth" className={`tw-input mono${e.authCode ? ' invalid' : ''}`} value={f.authCode} onChange={(ev) => setF({ ...f, authCode: ev.target.value })} />
        </Row>
      </div>
    </Dialog>
  );
}
