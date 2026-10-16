import { Fragment, useEffect, type ReactNode } from 'react';
import { ArrowLeft, FileDown, Home as HomeIcon, Printer } from 'lucide-react';
import { ui } from '../state/ui';
import { TASKS } from '../tasks';
import { LEVELS, type TaskDef } from '../tasks/types';
import { LAB } from '../state/baseline';
import { lastRoute } from '../brand/progress';
import { COMPANY, PRODUCT, TAGLINE } from '../brand/Brand';
import { NotebookDiagram } from './Diagram';
import { LESSONS, LEVEL_INTRO, NOTEBOOK_PDF } from './lessons';

const anchor = (id: string) => `nb-${id.replace('.', '-')}`;

/** Inline `code` → monospace. */
function rich(text: string): ReactNode {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>));
}

function Figure({ id, caption, n }: { id: string; caption: string; n: string }) {
  return (
    <figure className="nb-fig">
      <NotebookDiagram id={id} />
      <figcaption><b>Figure {n}.</b> {caption}</figcaption>
    </figure>
  );
}

function TaskLesson({ t }: { t: TaskDef }) {
  const l = LESSONS[t.id];
  return (
    <section className="nb-task" id={anchor(t.id)} aria-labelledby={`${anchor(t.id)}-h`}>
      <div className="nb-task-kicker">{LEVELS[t.level].name} · {t.difficulty} · about {t.minutes} minutes{t.scenario ? ' · scenario task' : ''}</div>
      <h3 id={`${anchor(t.id)}-h`}><span className="nb-id">{t.id}</span> {t.title}</h3>
      <p className="nb-lede">{rich(t.what)}</p>

      <div className="nb-box">
        <div><h4>The situation</h4><p>{rich(t.whatWeDo)}</p></div>
        <div><h4>Why it matters</h4><p>{rich(t.why)}</p></div>
      </div>

      {l ? (
        <>
          <h4>What it actually is</h4>
          {l.concept.map((p) => <p key={p}>{rich(p)}</p>)}
          <Figure id={l.diagram} caption={l.caption} n={t.id} />
          <h4>What happens under the hood</h4>
          {l.how.map((p) => <p key={p}>{rich(p)}</p>)}
        </>
      ) : null}

      {t.expected.length ? (
        <>
          <h4>Lab values</h4>
          <table className="nb-table">
            <tbody>{t.expected.map((e) => <tr key={e.label}><th>{e.label}</th><td><code>{e.value}</code></td></tr>)}</tbody>
          </table>
        </>
      ) : null}

      <h4>The steps, and why each one</h4>
      {t.scenario ? <p className="nb-muted">Start with <b>Start scenario</b> in the task panel: {t.scenario.label}</p> : null}
      <ol className="nb-steps">
        {t.steps.map((s) => (
          <li key={s.id}>
            <b>{s.title}</b>
            {s.expect ? <span className="nb-val"> · <code>{s.expect}</code></span> : null}
            {s.why ? <div className="nb-why">{rich(s.why)}</div> : null}
            {s.beginner ? <div className="nb-beg">{rich(s.beginner)}</div> : null}
          </li>
        ))}
      </ol>
      <p className="nb-muted">How it is verified: {rich(t.verify)}</p>

      <div className="nb-two">
        <div>
          <h4>Common mistakes</h4>
          <ul>{t.mistakes.map((m) => <li key={m}>{rich(m)}</li>)}</ul>
        </div>
        <div>
          <h4>If it does not work</h4>
          <ul>{t.troubleshooting.map((m) => <li key={m}>{rich(m)}</li>)}</ul>
        </div>
      </div>

      {l ? (
        <>
          <h4>Key terms</h4>
          <dl className="nb-terms">{l.terms.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{rich(v)}</dd></Fragment>)}</dl>
          <div className="nb-job"><h4>On the job</h4><p>{rich(l.job)}</p></div>
          <h4>Check yourself</h4>
          <ol className="nb-check">{l.check.map((c) => <li key={c.q}><b>{rich(c.q)}</b><div>{rich(c.a)}</div></li>)}</ol>
        </>
      ) : null}
    </section>
  );
}

const ESSENTIAL_SUBNETS: [string, string, string, string][] = [
  ['/32', '255.255.255.255', '1', 'one host (address objects)'],
  ['/29', '255.255.255.248', '8 (6 usable)', 'the ISP blocks on X1 and X3'],
  ['/24', '255.255.255.0', '256 (254 usable)', 'office LAN, DMZ, VLANs'],
  ['/0', '0.0.0.0', 'everything', 'the default route'],
];
const PORTS: [string, string, string][] = [
  ['DNS', 'UDP/TCP 53', 'name lookups'], ['HTTP', 'TCP 80', 'plain web'], ['HTTPS', 'TCP 443', 'encrypted web, firewall GUI'],
  ['SSH', 'TCP 22', 'remote command line'], ['RDP', 'TCP 3389', 'Windows remote desktop'], ['SMB', 'TCP 445', 'Windows file sharing'],
  ['IKE / IPsec', 'UDP 500, 4500', 'site-to-site VPN'], ['SSL VPN', 'TCP 4433 (lab)', 'remote access'], ['Syslog', 'UDP 514', 'central logging'],
];

/** ThreatReady learning notebook: long-form explanations of every task, readable online and downloadable as PDF. */
export function Notebook({ focus }: { focus?: string }) {
  useEffect(() => {
    ui.setRoute('notebook');
    document.title = `Learning notebook · ${PRODUCT} | ${COMPANY}`;
  }, []);
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(anchor(focus)) ?? document.getElementById(focus);
    if (el) setTimeout(() => el.scrollIntoView({ block: 'start' }), 60);
  }, [focus]);

  const edition = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const terms = new Map<string, string>();
  Object.values(LESSONS).forEach((l) => l.terms.forEach(([k, v]) => { if (!terms.has(k)) terms.set(k, v); }));
  const glossary = [...terms.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalMin = TASKS.reduce((a, t) => a + t.minutes, 0);
  const go = (id: string) => (e: React.MouseEvent) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ block: 'start' }); };

  return (
    <div className="nb-page">
      <div className="nb-toolbar tr-noprint">
        <img src={`${import.meta.env.BASE_URL}brand/aerovant-logo-light.svg`} alt="" aria-hidden="true" />
        <span className="div" aria-hidden="true" />
        <span className="word">ThreatReady · Learning notebook</span>
        <span className="sp" />
        <a className="tr-btn ghost" href="#/start"><HomeIcon size={14} /> Home</a>
        <a className="tr-btn ghost" href={`#/${lastRoute()}`}><ArrowLeft size={14} /> Back to lab</a>
        <button className="tr-btn ghost" onClick={() => window.print()}><Printer size={14} /> Print</button>
        <a className="tr-btn primary" href={NOTEBOOK_PDF} download data-guide="notebook-pdf"><FileDown size={14} /> Download PDF</a>
      </div>

      <article className="nb-paper">
        <header className="nb-cover">
          <img src={`${import.meta.env.BASE_URL}brand/aerovant-logo-light.svg`} alt="Aerovant Technologies" className="nb-cover-logo" />
          <div className="nb-cover-word">ThreatReady</div>
          <h1>{PRODUCT}<br /><span>Learning notebook</span></h1>
          <p className="nb-cover-tag">{TAGLINE}</p>
          <div className="nb-cover-meta">
            <div><b>{TASKS.length}</b> tasks</div><div><b>{LEVELS.length}</b> levels</div><div><b>~{Math.round(totalMin / 60)} h</b> hands-on</div><div><b>{edition}</b> edition</div>
          </div>
          <p className="nb-cover-note">Companion to the simulator. Every lab, host, address and attack in it is simulated; ThreatWall is a fictional appliance used for training.</p>
        </header>

        <nav className="nb-toc" aria-label="Contents">
          <h2>Contents</h2>
          <ol>
            <li><a href="#nb-use" onClick={go('nb-use')}>How to use this notebook</a></li>
            <li><a href="#nb-map" onClick={go('nb-map')}>The lab network</a></li>
            <li><a href="#nb-packet" onClick={go('nb-packet')}>How a packet crosses the firewall</a></li>
            <li><a href="#nb-basics" onClick={go('nb-basics')}>Networking essentials</a></li>
            {LEVELS.map((lv) => (
              <li key={lv.id}>
                <a href={`#nb-level-${lv.id}`} onClick={go(`nb-level-${lv.id}`)}>{lv.name}</a>
                <ol>{TASKS.filter((t) => t.level === lv.id).map((t) => <li key={t.id}><a href={`#${anchor(t.id)}`} onClick={go(anchor(t.id))}><span className="nb-id">{t.id}</span> {t.title}</a></li>)}</ol>
              </li>
            ))}
            <li><a href="#nb-glossary" onClick={go('nb-glossary')}>Glossary</a></li>
          </ol>
        </nav>

        <section className="nb-chapter" id="nb-use">
          <h2>How to use this notebook</h2>
          <p>The task panel in the simulator tells you <i>what</i> to do, one action at a time. This notebook tells you <i>why</i>: what each feature really is, what happens inside the firewall when you click OK, and how the same work looks on a real job. Read a lesson before you start the task, keep it open while you work, or come back to it when something does not make sense.</p>
          <p>Every lesson follows the same pattern:</p>
          <ul>
            <li><b>The situation</b> and <b>why it matters</b>: the business problem the task solves.</li>
            <li><b>What it actually is</b>: the concept in plain words, with a flow diagram.</li>
            <li><b>What happens under the hood</b>: the mechanism, step by step.</li>
            <li><b>Lab values</b> and <b>the steps, and why each one</b>: the exact settings with the reason behind each action.</li>
            <li><b>Common mistakes</b>, <b>if it does not work</b>, <b>key terms</b>, <b>on the job</b> and <b>check yourself</b>.</li>
          </ul>
          <p><b>How the lab works.</b> The screen is the browser on a lab PC called ADMIN-PC. Lab Tools at the bottom hold the PC console, the traffic tester, the list of lab hosts and lab controls (unplug a link, fail an ISP, power off a unit). Steps advance on their own when the saved configuration or a simulated test proves them; nobody types the configuration for you. Tasks unlock in order and a later change can make an earlier task show <i>Re-verify</i>, exactly as a real change can break something that used to work.</p>
          <p><b>Guided or Practice.</b> In Guided mode the panel shows values and highlights the next control. In Practice mode they stay hidden until you ask for a hint. A good routine: read the lesson, do the task in Guided mode, then repeat the level in Practice mode with this notebook closed.</p>
          <p className="nb-muted">All addresses are private ranges or documentation ranges (RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). Websites use fictional <code>.example</code> domains. Passwords, keys and one-time codes are training-only.</p>
        </section>

        <section className="nb-chapter" id="nb-map">
          <h2>The lab network</h2>
          <p>The fictional company AERO has a head office firewall, <code>{LAB.hostname}</code>, connecting the office LAN, a DMZ for the public web server, two internet links, a branch office over IPsec and remote staff over SSL VPN. By the end of Level 4 you will have built all of it.</p>
          <Figure id="topology" n="A" caption="The finished lab. Dashed lines are VPN tunnels that run over the internet." />
          <table className="nb-table">
            <thead><tr><th>Item</th><th>Address</th><th>Built in</th></tr></thead>
            <tbody>
              <tr><th>Factory management (X0)</th><td><code>192.168.168.168/24</code></td><td>0.1</td></tr>
              <tr><th>Office LAN (X0)</th><td><code>{LAB.lanIp}/24</code> · DHCP <code>{LAB.poolStart}–{LAB.poolEnd}</code></td><td>1.1, 1.3</td></tr>
              <tr><th>WAN, ISP-1 (X1)</th><td><code>{LAB.wanIp}/29</code> · gateway <code>{LAB.wanGw}</code></td><td>1.1</td></tr>
              <tr><th>DMZ (X2) · WEB-01</th><td><code>{LAB.dmzIp}/24</code> · server <code>{LAB.webServer}</code> · public <code>{LAB.publicWeb}</code></td><td>2.2</td></tr>
              <tr><th>VLANs on X0</th><td>{LAB.vlans.map((v) => `${v.id} ${v.zone} ${v.ip}/24`).join(' · ')}</td><td>2.4</td></tr>
              <tr><th>SSL VPN pool</th><td><code>{LAB.sslPoolStart}–{LAB.sslPoolEnd}</code></td><td>3.3</td></tr>
              <tr><th>Branch</th><td>peer <code>{LAB.branchWan}</code> · LAN <code>{LAB.branchLan}/24</code></td><td>3.4</td></tr>
              <tr><th>WAN, ISP-2 (X3)</th><td><code>{LAB.wan2Ip}/29</code> · gateway <code>{LAB.wan2Gw}</code></td><td>3.5</td></tr>
              <tr><th>Hosts</th><td>ADMIN-PC <code>{LAB.adminPc}</code> · HR-PC <code>{LAB.hrPc}</code> · FIN-PC <code>{LAB.finPc}</code> · PRINTER-01 <code>{LAB.printer}</code></td><td>—</td></tr>
            </tbody>
          </table>
        </section>

        <section className="nb-chapter" id="nb-packet">
          <h2>How a packet crosses the firewall</h2>
          <p>Almost every task changes one stage of this path. When something does not work, walk the path in order and ask which stage dropped the packet: the traffic tester and Packet Monitor in the simulator show exactly that.</p>
          <Figure id="pipeline" n="B" caption="The order of checks for a packet from the LAN to the internet. A drop at any stage ends the journey and is logged." />
          <ol>
            <li><b>Ingress.</b> The packet arrives on an interface, which tells the firewall its source zone.</li>
            <li><b>Anti-spoof.</b> If enforced, the source IP and MAC must match a known pair (task 1.4).</li>
            <li><b>Route lookup.</b> The most specific route decides the exit interface and therefore the destination zone (1.2, 3.5, 4.2).</li>
            <li><b>Zone pair.</b> Source and destination zones select which rule list applies, for example LAN → WAN.</li>
            <li><b>Access rules.</b> Read top-down; the first match allows or denies, and nothing matching means deny (1.6, 2.1, 2.3, 2.7).</li>
            <li><b>Security services.</b> IPS, anti-virus, content filter and application control inspect allowed traffic (2.5, 2.6, 3.1, 3.2).</li>
            <li><b>NAT.</b> Addresses are rewritten: private to public on the way out, public to private for published servers (1.6, 2.2).</li>
            <li><b>Egress.</b> The packet leaves and the connection is logged with the rule it matched.</li>
          </ol>
        </section>

        <section className="nb-chapter" id="nb-basics">
          <h2>Networking essentials</h2>
          <h4>Addresses and subnets</h4>
          <p>An IPv4 address is four numbers from 0 to 255. The subnet mask (or its short form, the CIDR prefix such as <code>/24</code>) says how many leading bits are the network part. Two devices in the same subnet talk directly; anything else goes through a router, here the firewall.</p>
          <table className="nb-table">
            <thead><tr><th>Prefix</th><th>Mask</th><th>Addresses</th><th>Used in this lab for</th></tr></thead>
            <tbody>{ESSENTIAL_SUBNETS.map((r) => <tr key={r[0]}><th><code>{r[0]}</code></th><td><code>{r[1]}</code></td><td>{r[2]}</td><td>{r[3]}</td></tr>)}</tbody>
          </table>
          <h4>Private, public and documentation addresses</h4>
          <p>Private ranges (<code>10.0.0.0/8</code>, <code>172.16.0.0/12</code>, <code>192.168.0.0/16</code>) are used inside organisations and never routed on the internet, which is why NAT exists. Public addresses are unique worldwide. Documentation ranges are reserved for examples like this lab and never belong to a real network.</p>
          <h4>Ports and services</h4>
          <table className="nb-table">
            <thead><tr><th>Service</th><th>Port</th><th>What it is</th></tr></thead>
            <tbody>{PORTS.map((r) => <tr key={r[0]}><th>{r[0]}</th><td><code>{r[1]}</code></td><td>{r[2]}</td></tr>)}</tbody>
          </table>
          <h4>Zones and trust</h4>
          <p>A zone groups interfaces with the same level of trust. Typical zones are LAN (trusted, your staff), WAN (untrusted, the internet), DMZ (servers others can reach) and special zones for VPN users. Rules are written between zones, so a new port added to an existing zone immediately follows that zone’s rules.</p>
          <h4>Stateful inspection</h4>
          <p>The firewall remembers every connection it allowed. Replies to an allowed connection are let back in automatically; you write rules for who may <i>start</i> a connection, not for the replies.</p>
        </section>

        {LEVELS.map((lv) => (
          <Fragment key={lv.id}>
            <section className="nb-level" id={`nb-level-${lv.id}`}>
              <div className="nb-level-num">Level {lv.id}</div>
              <h2>{lv.name.split(' — ')[1] ?? lv.name}</h2>
              <p className="nb-level-tag">{lv.tagline}</p>
              <p>{LEVEL_INTRO[lv.id]}</p>
              <ul className="nb-level-list">{TASKS.filter((t) => t.level === lv.id).map((t) => <li key={t.id}><span className="nb-id">{t.id}</span> {t.title} <span className="nb-muted">· ~{t.minutes} min</span></li>)}</ul>
            </section>
            {TASKS.filter((t) => t.level === lv.id).map((t) => <TaskLesson key={t.id} t={t} />)}
          </Fragment>
        ))}

        <section className="nb-chapter" id="nb-glossary">
          <h2>Glossary</h2>
          <dl className="nb-terms nb-glossary">{glossary.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{rich(v)}</dd></Fragment>)}</dl>
        </section>

        <footer className="nb-end">
          <p>All traffic, hosts and attacks described here are simulated in the learner’s browser. ThreatWall is a fictional appliance used for training, and AERO is a fictional company. Completing the track earns internal badges that show progress inside this simulation; they are not a certification.</p>
          <div className="nb-end-brand">{PRODUCT} · {COMPANY}</div>
          <div className="nb-end-copy">© {new Date().getFullYear()} {COMPANY} · ThreatReady</div>
        </footer>
      </article>
    </div>
  );
}
