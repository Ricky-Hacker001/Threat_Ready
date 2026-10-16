// Free, beginner-level explanations for each objective: the concept, why it matters, what the simulator does when you act,
// and how the lab decides the objective is done. These teach; the paid hints say exactly where to click.
export type Explain = { why: string; how: string; behind: string; done: string; nodes: string[] };

const REPORT_BEHIND = 'When you press "Report finding", the server checks two things: that the resource you chose really has this weakness, and that you opened the tab that shows the evidence first. A report on the wrong resource costs points, so look before you report.';
const VERIFY_BEHIND = 'Your change is applied to the simulated cloud straight away. Every check you see in the console (access, network, permission, encryption) is then worked out from the new settings, the same way AWS would. The finding only becomes "Verified" after you run tests that prove the hole is closed and normal use still works. If a later change undoes the fix, it drops back to unverified.';

export const EXPLAIN: Record<string, Explain> = {
  'L1.ack': {
    why: 'Every real incident starts with a ticket. Acknowledging it tells the team that someone owns the problem, so nobody assumes someone else is handling it.',
    how: 'The Incident Center holds the ticket (INC-2041), the company policies that define what "correct" looks like, and the evidence locker. You will come back here often.',
    behind: 'Acknowledging changes the ticket status from Open to Investigating and starts your record in the incident timeline. The lab clock is simulated: it moves forward a little with each action you take.',
    done: 'The ticket shows as acknowledged.', nodes: ['team'],
  },
  'V1.find': {
    why: 'An app should only be allowed to do what it needs. If its identity can do everything, then whoever steals its key can do everything too: read files, create users, switch off logging.',
    how: 'In IAM, permissions come from policies: JSON documents listing allowed actions ("s3:GetObject") on resources ("this bucket"). A "*" means "anything", which is a warning sign. Compare what the policy allows with what the app actually needs.',
    behind: REPORT_BEHIND,
    done: 'You reported the over-permissive policy on the right resource after viewing its permissions.', nodes: ['iam', 'app'],
  },
  'V1.fix': {
    why: 'Cutting permissions down ("least privilege") shrinks the blast radius: the next time a key leaks, the thief can only touch product images, not payroll or the audit log.',
    how: 'You rewrite the policy to allow only the few actions and resources the app uses. The Access Advisor tab shows what the app really did recently, so you are not guessing. Then you use the policy simulator, which answers "would this identity be allowed to do X?" without doing X.',
    behind: 'The simulator evaluates every policy that applies to the identity, plus account guardrails. An explicit "deny" anywhere wins; otherwise the action needs an "allow". It also re-checks app health: if you remove something the storefront needs, the App health tab shows an outage.',
    done: 'The policy is narrowed to what the app needs, one needed action tests as allowed and one unneeded action tests as denied.', nodes: ['iam', 'app', 'assets'],
  },
  'V2.find': {
    why: 'Confidential files (invoices, payroll) must never be readable by the whole internet. A public bucket is one of the most common causes of real data leaks.',
    how: 'An S3 bucket can be opened to the public in two ways: a bucket policy that allows "everyone" (Principal "*"), or an ACL that grants "AllUsers". The Permissions tab shows both.',
    behind: REPORT_BEHIND,
    done: 'You reported the public bucket after viewing its permissions.', nodes: ['docs', 'users'],
  },
  'V2.fix': {
    why: 'Until public access is closed, anyone who finds the bucket name can download confidential files, no password needed.',
    how: 'Block Public Access is a safety switch that overrides any public policy or ACL. Turning it on closes both paths at once. You then prove it with the access test: an anonymous request should fail, and the app server should still be able to use the bucket.',
    behind: 'The access test sends a pretend request and walks through the same decisions AWS does: is the key valid, does Block Public Access stop it, what do the bucket policy and ACL say, what does the caller\'s own IAM policy allow. The result tells you which rule decided.',
    done: 'Anonymous reads are denied and the app server role can still read or write the bucket.', nodes: ['docs', 'users', 'app'],
  },
  'V3.find': {
    why: 'A server open to the whole internet on admin ports (like SSH on 22 or a debugger) can be attacked directly, skipping the load balancer and its protections.',
    how: 'A security group is a firewall attached to a server. Each inbound rule says "allow this port from this source". A source of 0.0.0.0/0 means "anyone on the internet". The company network policy in the Incident Center lists which rules are allowed.',
    behind: REPORT_BEHIND,
    done: 'You reported the unrestricted security group after viewing its inbound rules.', nodes: ['app', 'users', 'alb'],
  },
  'V3.fix': {
    why: 'Only the load balancer should talk to the app, and only the office VPN should reach admin ports. Anything wider is an open door.',
    how: 'You remove or narrow the rules that allow 0.0.0.0/0, keeping the rule that lets the load balancer in. Then the reachability test checks whether traffic from a given source can reach a given port.',
    behind: 'The reachability test follows the path a network packet would take: route tables, then the security group rules on the target. If you remove the load balancer\'s rule by mistake, the storefront health check fails and an outage is recorded.',
    done: 'The internet can no longer reach the server directly, the load balancer still can, and the store stays up.', nodes: ['app', 'alb', 'users'],
  },
  'L1.trail': {
    why: 'Evidence can disappear. Saving a copy of the key event in the evidence locker keeps proof of what happened for the report, for legal teams and for your own timeline.',
    how: 'CloudTrail\'s event history lists every action: who did it, when, from which IP address and with which access key. Sort by time and look at the very last thing it recorded.',
    behind: 'Adding an event copies it into the evidence locker in the Incident Center. The lab checks which events you saved; the right one unlocks the next chapter of the story.',
    done: 'The last recorded audit event is in the evidence locker.', nodes: ['trail'],
  },
  'L2.declare': {
    why: 'You cannot stop an attacker until you know which credential they are using. Disabling the wrong key would break the store and leave the intruder in.',
    how: 'An access key is like a password for software. Each CloudTrail event records which key was used and from which IP. The app\'s own key is used from inside AeroCart\'s network; a key used from an unfamiliar outside address is suspicious.',
    behind: 'Declaring the key in the Incident Center records your conclusion. The server checks it against what really happened. It does not disable anything; that is the next step.',
    done: 'You declared the access key the intruder is actually using.', nodes: ['iam', 'trail', 'app'],
  },
  'L2.evidence': {
    why: 'Several events together show a pattern: what the intruder looked at, in what order and what they changed. One event alone is easy to explain away.',
    how: 'Filter the event history by the stolen access key or the outside IP address, then save the events made with that key.',
    behind: 'The lab counts saved events that were really made by the intruder. Saving your own or the app\'s normal events does not count.',
    done: 'At least three of the intruder\'s events are in the evidence locker.', nodes: ['trail', 'iam'],
  },
  'L2.contain': {
    why: 'Containment means stopping the damage now, even before the root cause is fixed. Every minute the intruder keeps a working key they can do more.',
    how: 'An IAM user can have more than one access key. Deactivating a key makes every request signed with it fail, without deleting anything. Intruders often create a second way back in (a "backdoor" user), so check for identities you do not recognise.',
    behind: 'The intruder runs on the lab clock: every action you take moves time forward, and about every 30 simulated minutes they try their next move. Their requests go through the same permission checks as yours, so once their keys are inactive, every attempt is rejected and shows up as "blocked". If you disable the app\'s own key instead, the storefront breaks and an outage is recorded.',
    done: 'Every key the intruder can use is inactive, and the storefront still works.', nodes: ['iam', 'app'],
  },
  'L2.verify': {
    why: 'Believing a key is off is not the same as proving it. Testing shows the door is actually shut.',
    how: 'The S3 access test can sign a pretend request with a specific access key. If the key is inactive, AWS rejects it before even looking at permissions.',
    behind: 'The simulator checks whether the key exists and is active before anything else. An inactive key returns InvalidAccessKeyId, the same error AWS would give.',
    done: 'A request signed with the stolen key is rejected as InvalidAccessKeyId while containment holds.', nodes: ['iam', 'docs'],
  },
  'V6.find': {
    why: 'Secrets (like a payment API key) written into an app\'s settings can be read by anyone who can view those settings, including an intruder with read access.',
    how: 'A Lambda function has "environment variables": name/value settings it reads when it runs. Storing a real credential there in plain text is a common mistake. The safe pattern is to store only a reference to a secret kept in Secrets Manager.',
    behind: REPORT_BEHIND,
    done: 'You reported the exposed secret after viewing the function\'s configuration.', nodes: ['fn', 'secrets', 'pay'],
  },
  'V6.fix': {
    why: 'Moving the secret is not enough if the old value already leaked. It must also be replaced (rotated) so the copy the intruder may have stops working.',
    how: 'Three things must be true: the value lives in Secrets Manager, the function holds only a reference (an ARN) to it, and the old value no longer works at the payment gateway.',
    behind: 'When the function test runs, the simulator fetches the secret using the function\'s role, then calls the payment gateway with it. Rotation creates a new value and tells the gateway to stop accepting the old one. The credential test tries a value against the gateway, so you can prove the leaked one is dead and the stored one works.',
    done: 'The secret is stored safely, the function still processes orders, and the exposed value is rejected.', nodes: ['fn', 'secrets', 'pay'],
  },
  'V4.find': {
    why: 'The audit log is how you know what happened. If it is off, or only records some regions or some kinds of action, attackers can work unseen.',
    how: 'A CloudTrail "trail" has three key settings: is it logging, does it cover all regions, and does it record read and write management events.',
    behind: REPORT_BEHIND,
    done: 'You reported the audit logging gap after viewing the trail\'s configuration.', nodes: ['trail'],
  },
  'V4.fix': {
    why: 'With logging back on and complete, every future action, including an attacker\'s, is recorded and can trigger alarms.',
    how: 'Start logging and widen what the trail covers. Then run the audit coverage test, which performs a harmless action and checks that it was recorded.',
    behind: 'Events made while logging was off are gone for good; the lab notes that gap in the timeline. Once logging is on, every new action you and the simulated users take appears in the event history and feeds the CloudWatch metrics.',
    done: 'The trail is logging all regions and all management events, and a test write made in another region shows up in the history.', nodes: ['trail', 'cw'],
  },
  'V5.find': {
    why: 'Encryption protects data even if storage is exposed. Company policy requires confidential files to use a key the company controls.',
    how: 'S3 can encrypt objects with an AWS-owned key or with your own KMS key (SSE-KMS). The bucket\'s Properties tab shows its default encryption.',
    behind: REPORT_BEHIND,
    done: 'You reported the weak encryption after viewing the bucket\'s properties.', nodes: ['docs', 'kms'],
  },
  'V5.fix': {
    why: 'Using the company\'s own key means access to the data also requires permission on the key: a second lock.',
    how: 'Changing default encryption only affects files saved afterwards. Existing files must be re-encrypted. Then test that the app can still write.',
    behind: 'The simulator records which key each object is encrypted with. A write by the app server needs both bucket permission and permission to use the key; if either is missing the test fails.',
    done: 'All objects use the company key and the app server can still write to the bucket.', nodes: ['docs', 'kms', 'app'],
  },
  'V7.find': {
    why: 'Like the app user, the order processor\'s role should only do its job. Extra permissions are extra damage if the function is ever abused.',
    how: 'A role is an identity a service borrows while it runs. Compare what the function actually does (its logs and Access Advisor) with what its policy allows.',
    behind: REPORT_BEHIND,
    done: 'You reported the over-permissive role after viewing its policy.', nodes: ['fn', 'iam'],
  },
  'V7.fix': {
    why: 'A tight role means a bug or compromise in the function cannot spread to the rest of the account.',
    how: 'Allow only the log, S3 export and single secret the function uses. Run the function test to prove it still works, and simulate an action it should not be able to do.',
    behind: 'The function test runs the real steps (fetch secret, charge, export, write logs) through the permission checker with the new role. If you cut too much, checkout fails and an outage is recorded.',
    done: 'The role allows only what is needed, the function still works, and an unneeded action is denied.', nodes: ['fn', 'iam', 'secrets'],
  },
  'V8.find': {
    why: 'Logs nobody reads do not stop attacks. Alarms turn suspicious activity into a notification someone acts on.',
    how: 'CloudWatch alarms watch a metric (a number over time) and fire when it crosses a threshold, sending a message to a topic people subscribe to.',
    behind: REPORT_BEHIND,
    done: 'You reported the missing alerting after viewing the alarms list.', nodes: ['cw', 'team'],
  },
  'V8.fix': {
    why: 'With an alarm on unauthorized API calls, the next intruder probing permissions triggers an alert within minutes instead of going unnoticed.',
    how: 'Create an alarm on the metric that counts denied API calls, with a sensible threshold, sending to the security team\'s topic. Then send test events to prove it fires.',
    behind: 'Denied requests in the simulator (including the intruder\'s blocked attempts) add to the UnauthorizedAPICalls metric. The alarm test injects events into that metric; if the threshold is crossed the alarm fires and a notification appears under the bell icon.',
    done: 'An alarm on unauthorized calls notifies the security topic, and a test shows it fires.', nodes: ['trail', 'cw', 'team'],
  },
  'V9.find': {
    why: 'An encryption key is only as safe as its access list. If "everyone" may use the key, encryption no longer protects anything.',
    how: 'A KMS key has its own key policy. It says who may manage the key (admins) and who may use it to encrypt and decrypt (users). Principal "*" means anyone.',
    behind: REPORT_BEHIND,
    done: 'You reported the over-permissive key policy after viewing it.', nodes: ['kms'],
  },
  'V9.fix': {
    why: 'Separating key admins from key users means no single identity can both change the rules and read the data.',
    how: 'Rewrite the key policy so only the app server role can use the key and only the key-admin role can manage it. Then run crypto tests as an outsider and as the app.',
    behind: 'The crypto test asks the key, on behalf of an identity, to encrypt or decrypt. The simulator reads the key policy (and IAM, where the policy delegates to it) to decide.',
    done: 'An identity with no need for the key is denied, and the app server role can still use it.', nodes: ['kms', 'app', 'docs'],
  },
  'V10.find': {
    why: 'Even an administrator was able to switch off the audit log. Guardrails are rules above IAM that nobody in the account can override.',
    how: 'Service control policies (SCPs) are set at the organization level and attached to accounts or groups of accounts (OUs). They can only deny; they never grant.',
    behind: REPORT_BEHIND,
    done: 'You reported the missing guardrail after viewing the organization policies.', nodes: ['org', 'trail'],
  },
  'V10.fix': {
    why: 'A guardrail that blocks tampering with the audit log protects your evidence even if an admin key is stolen.',
    how: 'Read each available policy and attach only the one that protects audit logging. Others would block production work. Then simulate switching off logging as a powerful user, and a normal action.',
    behind: 'Every permission check in the simulator includes the attached SCPs. A deny there beats any allow in IAM, which is why the policy simulator shows it as denied even for admins.',
    done: 'Switching off audit logging is denied for everyone, and normal actions still work.', nodes: ['org', 'trail', 'iam'],
  },
  'L3.regression': {
    why: 'Fixes can undo each other. A regression suite re-checks everything at once so you know the whole system is safe and working, not just the last thing you touched.',
    how: 'The regression suite in the Incident Center re-runs every verification and every app health check.',
    behind: 'The server re-evaluates all ten findings and all health probes against the current settings. Anything that fails is listed with the reason.',
    done: 'The suite passes with every finding verified and every service healthy.', nodes: ['app', 'docs', 'fn', 'trail', 'cw'],
  },
  'L4.logs': {
    why: 'Fixing the symptoms is not enough; you need to know how the key escaped in the first place, or it will happen again.',
    how: 'There are two possible explanations, and each leaves traces in a different log group in CloudWatch: one from the build system, one from the server\'s login log.',
    behind: 'Opening a log stream is recorded as having examined that evidence. The lab needs both streams examined, because a good investigator rules out the wrong explanation as well as confirming the right one.',
    done: 'You opened both log streams.', nodes: ['cw', 'app'],
  },
  'L4.triage': {
    why: 'Security teams get far more alerts than incidents. Classifying them correctly keeps people focused on real threats.',
    how: 'For each alert, ask: did anything actually get compromised? Classify it as a confirmed incident, a blocked attempt, expected activity or a false positive, based on evidence.',
    behind: 'Your classifications are saved, and are scored only when you submit the report, against what the evidence shows.',
    done: 'All three alerts are classified.', nodes: ['cw', 'team'],
  },
  'L4.report': {
    why: 'The report is what the business reads: what happened, what was affected, why, and how to stop it happening again.',
    how: 'Fill in the root cause, the timeline in order, the affected resources, remaining risks and the hardening plan. Use only what your evidence supports.',
    behind: 'The server scores each section against the real scenario and against what you actually did and verified, then produces the final assessment.',
    done: 'The report is submitted.', nodes: ['team'],
  },
};
