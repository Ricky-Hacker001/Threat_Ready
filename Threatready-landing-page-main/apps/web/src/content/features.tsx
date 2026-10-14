import type { AppKey, FeatureKey } from "@threatready/contracts";
import type { ReactNode } from "react";

export interface FeatureCopy {
  key: FeatureKey;
  /** The app (subdomain) that hosts this feature */
  app: AppKey;
  /** Path inside the app the card opens */
  path: string;
  title: string;
  description: string;
  action: string;
  /** Shown on the module page under the title */
  detail: string;
  art: ReactNode;
}

function Arrow() {
  return (
    <svg className="chain-arrow" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 8h9M9 4.5 12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Copy describes what each module does, per the requirements: no promises
 * beyond the implemented functionality, and simulations are clearly simulated.
 */
export const FEATURES: FeatureCopy[] = [
  {
    key: "interview",
    app: "interview",
    path: "/interview-prep",
    title: "InterviewPrep",
    description:
      "Practise technical interview questions for the security role you're aiming at, and strengthen the concepts behind your answers.",
    action: "Open InterviewPrep",
    detail: "Answer technical questions for your target role and see where your explanations need work.",
    art: (
      <div className="art-convo" aria-hidden="true">
        <div className="art-q">
          <span className="art-who">Interviewer</span>
          How would you tell a misconfigured S3 bucket from one that's public on purpose?
        </div>
        <div className="art-q you">
          <span className="art-who">You</span>
          I'd start with the bucket policy and who it grants…
        </div>
      </div>
    ),
  },
  {
    key: "simulations",
    app: "labs",
    path: "/",
    title: "Lab Simulations",
    description:
      "Work through hands-on scenarios in simulated security environments. Follow structured objectives to find and handle security issues. Nothing touches real systems.",
    action: "Browse labs",
    detail: "Scenario-based practice in simulated environments, with objectives that check your progress as you go.",
    art: (
      <div className="art-tickets" aria-hidden="true">
        <div className="ticket active">
          <span className="sev sev-high" />
          <span>Multiple failed logins, svc_ci</span>
          <span className="ticket-state">Triaging</span>
        </div>
        <div className="ticket">
          <span className="sev sev-med" />
          <span>New outbound connection, port 4444</span>
          <span className="ticket-state">Open</span>
        </div>
        <div className="ticket">
          <span className="sev sev-low" />
          <span>Certificate expires in 6 days</span>
          <span className="ticket-state">Open</span>
        </div>
      </div>
    ),
  },
  {
    key: "reasoning",
    app: "reasoning",
    path: "/",
    title: "Attack Reasoning Lab",
    description:
      "Examine an attack scenario, analyse the evidence and explain your reasoning. Get structured feedback on how well your explanation holds up.",
    action: "Browse scenarios",
    detail: "Study the evidence, write up what you think happened and why, and get feedback scored against a rubric.",
    art: (
      <div aria-hidden="true">
        <div className="art-chain">
          <div className="chain-node">
            <strong>Evidence</strong>
            4 failed logins
          </div>
          <Arrow />
          <div className="chain-node">
            <strong>Inference</strong>
            Password spray
          </div>
          <Arrow />
          <div className="chain-node verdict">
            <strong>Verdict</strong>
            Compromised
          </div>
        </div>
        <p className="chain-caption">
          Every claim needs its evidence
        </p>
      </div>
    ),
  },
];

export const featureByKey = (key: string) => FEATURES.find((f) => f.key === key);

/** Absolute URL of the app page a feature card opens, or null if the app isn't live. */
export function featureUrl(f: FeatureCopy, apps: { key: AppKey; url: string; status: string }[]): string | null {
  const app = apps.find((a) => a.key === f.app);
  if (!app || app.status !== "live") return null;
  return new URL(f.path, app.url).toString();
}
