/**
 * The auth page's one memorable element: a piece of evidence and the
 * reasoning a learner writes about it. Addresses are RFC 5737 documentation
 * ranges; the excerpt is illustrative.
 */
const LINES: { text: string; hit?: boolean }[] = [
  { text: "09:41:07  sshd   Failed password for admin from 203.0.113.48", hit: true },
  { text: "09:41:09  sshd   Failed password for deploy from 203.0.113.48", hit: true },
  { text: "09:41:10  sshd   Accepted publickey for ops from 198.51.100.7" },
  { text: "09:41:12  sshd   Failed password for backup from 203.0.113.48", hit: true },
  { text: "09:41:15  sshd   Failed password for svc_ci from 203.0.113.48", hit: true },
  { text: "09:41:18  sshd   Accepted password for svc_ci from 203.0.113.48", hit: true },
  { text: "09:41:40  CRON   (root) CMD (/usr/lib/sa/sa1 1 1)" },
  { text: "09:42:02  CRON   (svc_ci) RELOAD (crontabs/svc_ci)", hit: true },
];

export function CaseFile() {
  return (
    <aside className="casefile" aria-labelledby="casefile-title">
      <div className="casefile-head">
        <h2 id="casefile-title">Read the evidence. Explain what happened.</h2>
        <p>
          ThreatReady trains the judgement security interviews test: finding the signal in noisy logs and defending
          your call.
        </p>
      </div>

      <figure className="log" aria-label="Example authentication log from a Linux server">
        <figcaption className="log-title">auth.log on build-runner-02</figcaption>
        {/* The lines scroll sideways on a phone: focusable and named, so keyboard users can scroll it too. */}
        <div className="log-scroll" tabIndex={0} role="region" aria-label="auth.log lines, scrollable">
          <ol>
            {LINES.map((l) => (
              <li key={l.text} className={l.hit ? "hit" : undefined}>
                {l.text}
                {l.hit ? <span className="visually-hidden"> (marked as evidence)</span> : null}
              </li>
            ))}
          </ol>
        </div>
      </figure>

      <div className="annotation">
        <span className="annotation-mark" aria-hidden="true">
          A
        </span>
        <blockquote>
          Four usernames from one address in eleven seconds, then a hit on the CI service account and a new crontab a
          minute later. A password spray that worked, followed by persistence.
          <cite>Example answer from the Attack Reasoning Lab</cite>
        </blockquote>
      </div>
    </aside>
  );
}
