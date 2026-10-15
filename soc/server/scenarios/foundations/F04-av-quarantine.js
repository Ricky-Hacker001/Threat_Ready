// F4 · Antivirus detected and quarantined a file. Ground truth: a free PDF
// converter bundled adware; endpoint protection quarantined the bundled
// file before it ran and a follow-up scan was clean. True positive, contained.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom, BINARIES as B } from '../../engine/env.js';
import { fakeSha256 } from '../../engine/rng.js';
import { defineScenario, ran, single } from '../lib.js';

const U = account('t.nguyen');
const WS = hostNamed(U.host);
const DOMAIN = 'pdfconvert-free.example';
const SETUP = `C:\\Users\\${U.sam}\\Downloads\\PDFConvert_Setup.exe`;
const BUNDLE = `C:\\Users\\${U.sam}\\AppData\\Local\\Temp\\bndl\\offerhelper.exe`;
const HASH = fakeSha256('F4-offerhelper');
const SETUP_HASH = fakeSha256('F4-setup');

export default defineScenario({
  code: 'F4', level: 'foundations',
  title: 'Malware detected: Adware.BundleLoader (quarantined)', rule: 'EDR-0102', severity: 'medium', queue: 'endpoint',
  blurb: 'Endpoint protection reports a detection on a workstation.',
  sources: ['edr', 'proxy', 'dns', 'winsec', 'firewall', 'email'], sourceGroups: ['endpoint'],
  skills: ['log.endpoint', 'kno.malware', 'tri.severity'],
  entities: { domains: [DOMAIN] },
  alertTags: ['detect'],
  build(x) {
    x.add('download', E.edr(x.T(-190), WS.name, 15, 'FileCreateStreamHash', { user: dom(U.sam), image: B.edge.path, target_filename: SETUP, zone_id: `ZoneId=3 HostUrl=https://${DOMAIN}/get/PDFConvert_Setup.exe`, sha256: SETUP_HASH }));
    x.add('run', E.procCreate(x.T(-130), WS.name, { user: dom(U.sam), image: SETUP, command_line: `"${SETUP}"`, pid: 6112, parent_image: B.explorer.path, ppid: 1036, sha256: SETUP_HASH, signature: 'Not signed' }));
    x.add('dropped', E.edr(x.T(-125), WS.name, 11, 'FileCreate', { user: dom(U.sam), image: SETUP, pid: 6112, target_filename: BUNDLE, sha256: HASH }));
    x.add('detect', E.edr(x.T(-3), WS.name, 1116, 'Malware detected', { user: dom(U.sam), target_filename: BUNDLE, sha256: HASH, details: 'threat=Adware.BundleLoader action=quarantine result=success' }));
    x.add('scan_clean', E.edr(x.T(90), WS.name, 1001, 'Scan completed', { user: 'NT AUTHORITY\\SYSTEM', details: 'scan=quick threats_found=0 result=clean' }));
  },
  alert: ({ tagged }) => ({
    description: `Endpoint protection detected Adware.BundleLoader on ${WS.name} and reports action quarantine.`,
    entity: { host: WS.name, ip: WS.ip, user: U.sam },
    details: [['Host', WS.name], ['File', BUNDLE], ['SHA-256', HASH], ['Detection', 'Adware.BundleLoader'], ['Reported action', tagged('detect')[0].fields.details]],
    guidance: ['Confirm what the protection did and whether it worked.', 'Find out whether the flagged file ever ran.', 'Find out where it came from.'],
  }),
  sandbox: { [HASH]: { verdict: 'suspicious', score: 45, facts: [['Family', 'Adware.BundleLoader'], ['Type', 'Bundled offer installer']], behaviours: ['Shows offers during install', 'Changes the browser home page', 'No credential access, no persistence beyond a start-menu shortcut'], network: [`ads.${DOMAIN}`], dropped: [] } },
  intel: { [HASH]: { verdict: 'suspicious', detections: '24/72', facts: [['Family', 'Adware.BundleLoader'], ['Type', 'Potentially unwanted program'], ['Behaviour', 'Shows offers, changes the browser home page; no credential theft']], notes: ['Common in bundled freeware installers.'] }, [DOMAIN]: { verdict: 'suspicious', detections: '3/89', facts: [['Category', 'Freeware / bundled installers'], ['Registered', '2 years ago']], notes: ['Distributes free utilities bundled with adware offers.'] } },
  triage: {
    checks: [
      { id: 'asset', label: 'Host looked up in the asset inventory', test: ran('asset', [WS.name, WS.ip]) },
      { id: 'hash', label: 'File hash checked in threat intelligence', test: ran('reputation', HASH) },
    ],
    fields: [
      single('av_action', 'What endpoint protection did', 6, [['quarantined', 'Quarantined successfully'], ['failed', 'Quarantine failed'], ['allowed', 'Allowed the file'], ['deleted_after', 'Deleted it after it ran']], 'quarantined', { hint: 'Read the action and result in the detection details.', explain: 'The detection reports action=quarantine result=success, and the follow-up scan is clean.', skills: ['log.endpoint'] }),
      single('ran', 'Did the flagged file ever start', 6, [['no', 'No: there is no process start for it'], ['yes', 'Yes: it ran before detection'], ['unknown', 'Cannot tell from the logs']], 'no', { hint: 'Search for a process create for the flagged file name.', explain: 'There is a process start for the installer but none for offerhelper.exe.', skills: ['log.endpoint', 'inv.search'] }),
    ],
    verdict: { accept: { tp: 1, btp: 0.3 }, explain: 'It is real unwanted software, so a true positive; protection stopped it.' },
    severity: { accept: 'low', explain: 'Contained adware on one host, never executed.' },
    evidence: { tags: ['detect', 'scan_clean'], explain: 'The detection with its result plus the clean scan prove containment.' },
  },
  closure: {
    disposition: { options: [['contained', 'True positive, contained by endpoint protection'], ['incident', 'Active infection; incident'], ['fp', 'False positive'], ['benign', 'Benign, authorised software']], accept: 'contained', explain: 'Real adware, quarantined before it ran.' },
    rootCause: { options: [['freeware', 'User installed unapproved freeware that bundled adware'], ['phish', 'Phishing email attachment'], ['exploit', 'Browser exploit'], ['usb', 'Infected USB drive']], accept: 'freeware', explain: 'The installer was downloaded from a freeware site and dropped the bundled offer.' },
    actions: { options: [['confirm', 'Confirm the quarantine and the clean scan'], ['block', `Block ${DOMAIN} at the proxy`], ['remind', 'Remind the user to use the software portal'], ['reimage', `Re-image ${WS.name}`], ['reset', 'Reset the user\'s password']], set: ['confirm', 'block', 'remind'], explain: 'Nothing ran and nothing stole credentials, so re-imaging or resetting is over-response.' },
  },
  truth: { summary: `${U.name} downloaded a free PDF converter from ${DOMAIN}. The installer bundled an adware offer, offerhelper.exe. Endpoint protection quarantined it before it ran and a quick scan ninety seconds later was clean.`, timeline: [[-190, 'Installer downloaded.'], [-130, 'Installer started.'], [-3, 'Bundled file detected and quarantined.'], [90, 'Follow-up scan clean.']], iocs: [{ type: 'domain', value: DOMAIN, note: 'Freeware site bundling adware' }, { type: 'sha256', value: HASH, note: 'offerhelper.exe' }] },
  test: { tools: { l1_triage: [['asset', WS.name], ['reputation', HASH]] } },
});
