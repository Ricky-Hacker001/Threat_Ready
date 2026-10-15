import { Globe2, CloudOff, Terminal } from 'lucide-react';
import { BrowserFrame } from './BrowserFrame';
import { ui } from '../state/ui';
import { useStore } from '../state/store';

export function NewTab() {
  const { session } = useStore();
  return (
    <BrowserFrame>
      <main className="tw-newtab">
        <Globe2 size={42} color="#9aa0a6" />
        <h1>New tab</h1>
        <p>Type the firewall’s management address in the address bar above and press Enter.</p>
        <p className="muted">
          {session.pc.cabled ? (session.pc.ip ? <>ADMIN-PC is <b className="mono">{session.pc.ip}</b>.</> : 'ADMIN-PC has no IP address yet — open Lab Tools › PC Console.') : 'ADMIN-PC is not cabled to the firewall yet — open Lab Tools › PC Console.'}
        </p>
        <button className="tw-btn" onClick={() => ui.openLab('pc')}><Terminal size={13} style={{ verticalAlign: -2 }} /> Open PC Console</button>
      </main>
    </BrowserFrame>
  );
}

export function BrowserError({ code, title, detail }: { code: string; title: string; detail: string }) {
  return (
    <BrowserFrame>
      <main className="tw-newtab err" role="alert">
        <CloudOff size={42} color="#5f6368" />
        <h1>{title}</h1>
        <p>{detail}</p>
        <p className="tw-cert-code">{code}</p>
        <p className="muted">Check the PC (cable, IP address, gateway) and the address you typed. On real kit this page is all you would see; the lab adds the reason above.</p>
        <button className="tw-btn" onClick={() => ui.openLab('pc')}><Terminal size={13} style={{ verticalAlign: -2 }} /> Open PC Console</button>
      </main>
    </BrowserFrame>
  );
}
