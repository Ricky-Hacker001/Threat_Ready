// I6 · Mass file modification on a file share: an approved migration job.

import { E } from '../../engine/format.js';
import { hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single, account as acct } from '../lib.js';

const MIG = hostNamed('MIG01');
const CHG = 'CHG-4519';
const FOLDERS = ['Contracts', 'Rates', 'Tenders', 'Customers', 'Archive', 'Drawings'];
const EXTS = ['docx', 'xlsx', 'pdf', 'pptx', 'dwg'];

export default defineScenario({
  code: 'I6', level: 'intermediate', benign: true,
  title: 'Over 1,000 file changes on one share in 10 minutes', rule: 'FILE-0400', severity: 'high', queue: 'file activity',
  blurb: 'A file-audit rule reports a very large number of file changes on one share.',
  sources: ['fileaudit', 'winsec', 'edr', 'proxy', 'dns', 'firewall'], sourceGroups: ['windows'],
  skills: ['log.windows-auth', 'tri.false-positive', 'kno.malware', 'inv.pivot'],
  entities: { ids: [CHG] },
  alertTags: ['migrate'],
  build(x) {
    const n = x.n(1150, 1050);
    for (let i = 0; i < n; i++) {
      const p = `D:\\Shares\\Projects\\${FOLDERS[i % 6]}\\P${1000 + (i % 400)}_${['spec', 'quote', 'plan', 'notes'][i % 4]}.${EXTS[i % 5]}`;
      x.add('migrate', E.fileaudit(x.T(-560 + i * 0.48), { user: dom('svc_migrate'), share: '\\\\FS01\\Projects', path: p, access: i % 2 ? 'DELETE' : 'ReadData', event_id: i % 2 ? 4660 : 4663, process: 'C:\\Windows\\System32\\robocopy.exe', src_ip: MIG.ip }));
      if (i % 5 === 0) x.add('migrate_dst', E.fileaudit(x.T(-559 + i * 0.48), { server: 'FS02', user: dom('svc_migrate'), share: '\\\\FS02\\Projects', path: p.replace('D:\\Shares', 'E:\\Shares'), access: 'WriteData', process: 'C:\\Windows\\System32\\robocopy.exe', src_ip: MIG.ip }));
    }
    x.add('decoy_bak', E.fileaudit(x.T(-300), { user: dom('j.whitfield'), share: '\\\\FS01\\Projects', path: 'D:\\Shares\\Projects\\Rates\\Rates_2026.xlsx.bak', access: 'WriteData', process: 'C:\\Windows\\explorer.exe', src_ip: hostNamed('WS-OPS-004').ip }));
  },
  alert: ({ tagged }) => ({
    description: `${tagged('migrate').length} file changes on \\\\FS01\\Projects in under 10 minutes.`,
    entity: { host: 'FS01', ip: MIG.ip, user: 'svc_migrate' },
    details: [['Share', '\\\\FS01\\Projects'], ['Changes', String(tagged('migrate').length)], ['Rule logic', '1,000+ file read/delete/write events on one share within 10 minutes']],
    guidance: ['Find out who and what made the changes.', 'Look for what ransomware would leave behind.', 'Check whether the activity is approved.'],
  }),
  changes: [{ id: CHG, title: 'Projects share migration to FS02', scope: 'Move \\\\FS01\\Projects to \\\\FS02\\Projects with robocopy from MIG01 as svc_migrate', owner: 'IT Infrastructure (r.khan)', status: 'Approved, in progress', start: -15, end: 240, detail: 'Files are copied to FS02 and removed from FS01. Names and extensions do not change.' }],
  triage: {
    checks: [
      { id: 'chg', label: 'Change calendar searched', test: ran('change') },
      { id: 'dir', label: 'Account looked up in the directory', test: ran('user', 'svc_migrate') },
    ],
    fields: [
      acct('who', 'Account making the changes', 4, 'svc_migrate', { hint: 'Read the user field.', explain: 'Every change is by the migration service account.', skills: ['log.windows-auth'] }),
      single('ransom_signs', 'Signs of ransomware', 8, [['none', 'None: extensions unchanged, no notes, no shadow-copy deletion'], ['ext', 'New file extensions'], ['notes', 'Ransom notes'], ['vss', 'Shadow copies deleted']], 'none', { hint: 'What would ransomware leave behind?', explain: 'Extensions are unchanged, no ransom notes, no vssadmin. The single .bak file is a user\'s manual copy.', skills: ['kno.malware'] }),
    ],
    verdict: { accept: { btp: 1, fp: 0.4 }, explain: 'Real mass changes, authorised.' },
    severity: { accept: 'low', explain: 'Approved migration.' },
    evidence: { tags: ['migrate', 'migrate_dst'], explain: 'Reads and deletes on FS01 and the matching writes on FS02.' },
  },
  review: { explain: 'The change calendar and the robocopy process explain this; Tier 1 could close it.' },
  closure: {
    disposition: { options: [['benign', 'Benign: approved migration'], ['ransomware', 'Ransomware'], ['insider', 'Insider deleting data'], ['unknown', 'Unknown']], accept: 'benign', explain: 'Matches the change exactly.' },
    rootCause: { options: [['migration', 'Approved migration job'], ['ransom', 'Ransomware encryption'], ['sync', 'OneDrive sync conflict'], ['av', 'Antivirus scan']], accept: 'migration', explain: 'robocopy as svc_migrate under the change.' },
    actions: { options: [['close', 'Close the ticket'], ['suppress', 'Suggest suppressing the rule for svc_migrate during the change window only'], ['disable', 'Disable svc_migrate'], ['isolate', 'Isolate FS01']], set: ['close', 'suppress'], explain: 'Stopping an approved migration halfway risks data loss.' },
  },
  truth: { summary: `An approved migration (${CHG}) run by svc_migrate with robocopy from MIG01 is moving the Projects share to FS02. File names and extensions do not change and there are no ransomware signs. One user's .bak copy on the same share is unrelated.`, timeline: [[-560, 'Migration copy starts.'], [5, 'FILE-0400 fires.']] },
  test: { tools: { l1_triage: [['change', ''], ['user', 'svc_migrate']] } },
});
