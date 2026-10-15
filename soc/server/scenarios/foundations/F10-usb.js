// F10 · USB mass-storage device connected. Ground truth: the company-issued
// encrypted USB registered to this user, used for a customer visit. Benign.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single } from '../lib.js';

const U = account('k.yamamoto');
const WS = hostNamed(U.host);
const SERIAL = 'SDC32-7741-Q042';
const CUSTOMER = 'Nordhaven';

export default defineScenario({
  code: 'F10', level: 'foundations', benign: true,
  title: 'Removable storage device connected', rule: 'EDR-0210', severity: 'low', queue: 'endpoint',
  blurb: 'Endpoint protection reports a removable storage device connected to a workstation.',
  sources: ['edr', 'proxy', 'dns', 'winsec', 'firewall', 'email'], sourceGroups: ['endpoint'],
  skills: ['log.endpoint', 'inv.pivot', 'tri.verdict'],
  entities: { names: [SERIAL] },
  alertTags: ['usb_on'],
  build(x) {
    x.add('usb_on', E.edr(x.T(-60), WS.name, 6416, 'Device connected', { user: dom(U.sam), details: `class=USBSTOR vendor=SecureDrive model="SD-Crypt 32" serial=${SERIAL} hardware_encrypted=true` }));
    x.add('copy', E.edr(x.T(-20), WS.name, 11, 'FileCreate', { user: dom(U.sam), image: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE', target_filename: `E:\\Visit\\${CUSTOMER}_proposal.pptx`, file_size: x.n(6, 4) * 1048576 }));
    x.add('usb_off', E.edr(x.T(60), WS.name, 6420, 'Device removed', { user: dom(U.sam), details: `serial=${SERIAL}` }));
  },
  alert: () => ({
    description: `A USB mass-storage device was connected to ${WS.name} by ${U.sam}.`,
    entity: { host: WS.name, ip: WS.ip, user: U.sam },
    details: [['Host', WS.name], ['User', U.sam], ['Device', 'SecureDrive SD-Crypt 32'], ['Serial', SERIAL]],
    guidance: ['Identify the device by its serial number.', 'Check what was written to it.'],
  }),
  assetRecords: { [SERIAL.toLowerCase()]: { facts: [['Asset tag', 'USB-0042'], ['Device', 'SecureDrive SD-Crypt 32 (hardware encrypted)'], ['Serial', SERIAL], ['Issued to', `${U.name} (${U.sam})`]], notes: ['Company-issued encrypted drive.'] } },
  triage: {
    checks: [{ id: 'asset', label: 'Device serial looked up in the asset inventory', test: ran('asset', SERIAL) }],
    fields: [
      single('approved', 'Is the device approved', 6, [['own', 'Yes: company device issued to this user'], ['other', 'Company device issued to someone else'], ['unknown', 'Not on the asset list'], ['personal', 'A personal device']], 'own', { hint: 'Search the asset inventory by serial number.', explain: 'The serial is USB-0042, issued to the same user.', skills: ['inv.pivot'] }),
      single('data', 'What was written to it', 6, [['one_file', 'One work file, a few MB'], ['bulk', 'Thousands of files'], ['nothing', 'Nothing'], ['exe', 'An executable']], 'one_file', { hint: 'Search file creates on drive E:.', explain: 'One presentation for a customer visit.', skills: ['log.endpoint'] }),
    ],
    verdict: { accept: { btp: 1, fp: 0.4 }, explain: 'A real device connection, approved.' },
    severity: { accept: 'low', explain: 'Approved encrypted device, one business file.' },
    evidence: { tags: ['usb_on', 'copy'], explain: 'The connection and what was copied.' },
  },
  closure: {
    disposition: { options: [['benign', 'Benign: approved encrypted USB used for business'], ['dlp', 'Data theft'], ['malware', 'Malware from USB'], ['unknown', 'Unknown']], accept: 'benign', explain: 'Company device, owner, one work file.' },
    rootCause: { options: [['approved', 'Approved encrypted USB used for business'], ['theft', 'Data theft'], ['rubber', 'A malicious USB device'], ['policy', 'USB policy disabled']], accept: 'approved', explain: 'Normal business use.' },
    actions: { options: [['close', 'Close and record the asset tag on the ticket'], ['hr', 'Escalate to HR'], ['block_usb', `Block all USB storage on ${WS.name}`], ['reimage', `Re-image ${WS.name}`]], set: ['close'], explain: 'Nothing to fix.' },
  },
  truth: { summary: `${U.name} plugged in the company-issued encrypted USB drive registered to him (USB-0042) and saved one presentation for a customer visit.`, timeline: [[-60, 'Drive connected.'], [-20, 'Presentation saved to E:.'], [60, 'Drive removed.']] },
  test: { tools: { l1_triage: [['asset', SERIAL]] } },
});
