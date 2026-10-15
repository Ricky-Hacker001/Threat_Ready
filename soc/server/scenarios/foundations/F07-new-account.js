// F7 · New user account created. Ground truth: a new joiner's account,
// created by IT under an HR ticket during business hours. Benign.

import { E } from '../../engine/format.js';
import { account, dom } from '../../engine/env.js';
import { defineScenario, ran, single, account as acct } from '../lib.js';

const NEW = account('n.okoye');
const IT = account('r.khan');
const TICKET = 'HR-2219';

export default defineScenario({
  code: 'F7', level: 'foundations', benign: true,
  title: 'New domain user account created', rule: 'IAM-0010', severity: 'low', queue: 'identity',
  blurb: 'A directory rule reports that a new user account was created.',
  sources: ['winsec', 'dns', 'proxy', 'edr', 'firewall', 'email'], sourceGroups: ['windows'],
  skills: ['log.windows-auth', 'tri.verdict', 'doc.evidence'],
  entities: { ids: [TICKET] },
  alertTags: ['create'],
  build(x) {
    x.add('create', E.winsec(x.T(-40), 'DC01', 4720, 'A user account was created', { subject_user: dom(IT.sam), target_user: dom(NEW.sam) }));
    x.add('groups', E.winsec(x.T(-20), 'DC01', 4728, 'A member was added to a security-enabled global group', { subject_user: dom(IT.sam), target_user: dom(NEW.sam), object_name: 'Domain Users' }));
    x.add('groups', E.winsec(x.T(-19), 'DC01', 4728, 'A member was added to a security-enabled global group', { subject_user: dom(IT.sam), target_user: dom(NEW.sam), object_name: 'SG-Sales' }));
    x.add('enable', E.winsec(x.T(-10), 'DC01', 4722, 'A user account was enabled', { subject_user: dom(IT.sam), target_user: dom(NEW.sam) }));
    x.add('enable', E.winsec(x.T(-9), 'DC01', 4738, 'A user account was changed', { subject_user: dom(IT.sam), target_user: dom(NEW.sam), privileges: 'Password last set changed' }));
  },
  alert: () => ({
    description: `New domain account ${NEW.sam} created by ${IT.sam}.`,
    entity: { host: 'DC01', ip: null, user: NEW.sam },
    details: [['New account', NEW.sam], ['Created by', IT.sam], ['Rule logic', 'Any 4720 (user account created)']],
    guidance: ['Find the approval for the account.', 'Check every group it was added to.'],
  }),
  changes: [{ id: TICKET, title: `New starter ${NEW.sam}, Sales, starts today`, scope: `Create account ${NEW.sam}; standard Sales groups only`, owner: 'HR (approved by the Sales Director)', status: 'Approved', start: -24 * 60, end: 8 * 60, detail: 'Standard joiner process. Account to be created by IT on the start date.' }],
  triage: {
    checks: [
      { id: 'chg', label: 'Change calendar or ticket searched for the new account', test: ran('change') },
      { id: 'dir', label: 'Creator looked up in the directory', test: ran('user', IT.sam) },
    ],
    fields: [
      acct('creator', 'Who created the account', 4, IT.sam, { hint: 'Read the subject of the 4720.', explain: 'The 4720 subject is the IT administrator.', skills: ['log.windows-auth'] }),
      single('approval', 'Approval for the account', 6, [['match', 'A ticket matches the name, team and date'], ['other', 'A ticket exists but for another person'], ['none', 'There is no ticket'], ['future', 'The ticket is for next month']], 'match', { hint: 'Search the change calendar for the account name.', explain: `${TICKET} is the HR joiner ticket for this person, starting today.`, skills: ['tri.false-positive'] }),
      single('privileged', 'Was it added to any privileged group', 6, [['no', 'No: standard groups only'], ['da', 'Yes: Domain Admins'], ['local', 'Yes: local administrators'], ['unknown', 'Cannot tell']], 'no', { hint: 'Check every group change after the creation.', explain: 'Only Domain Users and SG-Sales.', skills: ['log.windows-auth'] }),
    ],
    verdict: { accept: { btp: 1, fp: 0.4 }, explain: 'A real account creation, approved.' },
    severity: { accept: 'low', explain: 'An approved joiner with standard rights.' },
    evidence: { tags: ['create', 'groups'], explain: 'The creation and the group changes.' },
  },
  closure: {
    disposition: { options: [['benign', 'Benign: approved new joiner'], ['rogue', 'Rogue account'], ['fp', 'False positive'], ['unknown', 'Unknown']], accept: 'benign', explain: 'Matches the HR ticket.' },
    rootCause: { options: [['joiner', 'Approved new-joiner account'], ['attacker', 'Attacker persistence'], ['test', 'Test account left behind'], ['sync', 'Directory sync error']], accept: 'joiner', explain: 'Created by IT under the HR joiner ticket.' },
    actions: { options: [['record', 'Record the ticket number on the ticket and close'], ['disable', 'Disable the new account'], ['remove', 'Remove the administrator\'s rights'], ['reset', 'Reset the new account\'s password']], set: ['record'], explain: 'Nothing to fix; the record links alert and approval.' },
  },
  truth: { summary: `${NEW.name} starts in Sales today. ${IT.name} created the account under HR ticket ${TICKET} and added only the standard groups.`, timeline: [[-40, 'Account created.'], [-20, 'Added to Domain Users and SG-Sales.'], [-10, 'Account enabled.']] },
  test: { tools: { l1_triage: [['change', ''], ['user', IT.sam]] } },
});
