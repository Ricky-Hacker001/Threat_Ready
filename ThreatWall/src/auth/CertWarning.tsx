import { useEffect, useState } from 'react';
import { ui, useDraft } from '../state/ui';
import { ShieldAlert } from 'lucide-react';
import { BrowserFrame } from './BrowserFrame';
import { useStore } from '../state/store';

/** Task 0.2: the one browser warning an admin should expect — a new appliance's self-signed certificate. */
export function CertWarning() {
  const { session, patchSession, addAudit } = useStore();
  const [advanced, setAdvanced] = useState(false);
  const host = session.connectedIp;
  useEffect(() => { ui.setRoute('browser:cert'); }, []);
  useDraft('cert', { advanced });

  return (
    <BrowserFrame host={host} trusted={false}>
      <main className="tw-cert">
        <div className="tw-cert-box">
          <ShieldAlert size={52} color="#c5221f" aria-hidden="true" />
          <h1>Your connection is not private</h1>
          <p>
            Attackers might be trying to steal your information from <strong>{host}</strong> (for example, passwords, messages or
            credit cards).
          </p>
          <p className="tw-cert-code">NET::ERR_CERT_AUTHORITY_INVALID</p>

          <div className="tw-cert-actions">
            <button className="tw-cert-btn" data-guide="cert-advanced" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
              {advanced ? 'Hide advanced' : 'Advanced'}
            </button>
            <button className="tw-cert-btn primary" onClick={() => setAdvanced(false)}>Back to safety</button>
          </div>

          {advanced ? (
            <div className="tw-cert-adv">
              <p>
                This server could not prove that it is <strong>{host}</strong>; its security certificate is not trusted by your
                computer’s operating system. The certificate is self-signed by the appliance.
              </p>
              <p className="muted" style={{ fontSize: 13.5 }}>
                Lab note: on a brand-new firewall this warning is expected, because it ships with a self-signed certificate. Check
                that the address is the firewall you just cabled to, then proceed. Task 4.4 replaces this certificate so the
                warning goes away.
              </p>
              <button
                data-guide="cert-proceed"
                className="link"
                onClick={() => {
                  patchSession({ certAccepted: true });
                  addAudit([{ category: 'Session', action: 'Certificate warning accepted', detail: `Proceeded to https://${host} (self-signed)` }]);
                }}
              >
                Proceed to {host} (unsafe)
              </button>
            </div>
          ) : null}
        </div>
      </main>
    </BrowserFrame>
  );
}
