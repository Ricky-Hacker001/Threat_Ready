import type { ActivityApp, AppKey } from "@threatready/contracts";
import { fmtInt } from "../lib/format";

/* Labels and small charts shared by the admin overview and the user page. */

export const ACTIVITY_APP_LABEL: Record<ActivityApp, string> = {
  home: "ThreatReady home",
  interview: "InterviewPrep",
  labs: "Lab Simulations",
  reasoning: "Attack Reasoning Lab",
};

const LAB_AREAS: Record<string, string> = {
  soc: "SOC Simulation",
  devsecops: "DevSecOps Lab",
  threatwall: "ThreatReady Firewall",
  redteam: "Web Pentest Lab (Red Team)",
  aisec: "AI Security Lab",
  "TR-CLOUD-001": "The Compromised Startup (AWS)",
};

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Where in an app, in words: "SOC Simulation", "In an interview", "Cloud Security", … */
export function areaLabel(app: ActivityApp, area: string): string {
  if (app === "labs") return area ? (LAB_AREAS[area] ?? area) : "Catalog";
  if (app === "interview")
    return ({ "": "Dashboard", interview: "In an interview", report: "Reports", new: "Setting up an interview", history: "History" } as Record<string, string>)[area] ?? titleCase(area);
  if (app === "reasoning") return ({ "": "Domains", attempt: "Assessments", history: "History" } as Record<string, string>)[area] ?? titleCase(area);
  return ({ "": "Home", profile: "Profile", admin: "Admin console" } as Record<string, string>)[area] ?? titleCase(area);
}

/** What each LLM feature is for (codes come from each app's AI ledger); unknown codes show as-is. */
const FEATURES: Record<string, string> = {
  "interview.analysis": "Resume and job analysis",
  "interview.analyse": "Resume and job analysis",
  "interview.question": "Interview questions",
  "interview.turn_evaluation": "Answer evaluation",
  "interview.clarify": "Clarifying questions",
  "interview.final_scoring": "Final scoring and report",
  "interview.report_pdf": "Report PDF",
  "interview.sweep": "Session clean-up",
  "reasoning.generate": "Scenario generation",
  "reasoning.evaluate": "Answer evaluation",
  "reasoning.pool_refill": "Question pool refill (shared)",
};
export function featureLabel(code: string): string {
  if (FEATURES[code]) return FEATURES[code];
  const m = /^reasoning[._](challenger|evaluator|reconciler|item|generate|evaluate|pool_refill)/.exec(code);
  if (m) return ({ challenger: "Answer challenge", evaluator: "Answer evaluation", reconciler: "Score reconciliation", item: "Question generation", generate: "Scenario generation", evaluate: "Answer evaluation", pool_refill: "Question pool refill (shared)" } as Record<string, string>)[m[1]!]!;
  return titleCase(code.split(".").pop() ?? code);
}

let regionNames: Intl.DisplayNames | null = null;
/** "India", "Local network", "Unknown". */
export function countryName(code: string | null | undefined): string {
  if (!code || code === "ZZ") return "Unknown";
  if (code === "LO") return "Local network";
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Legacy IANA names browsers still report, shown under their current name. */
const TZ_ALIASES: Record<string, string> = { "Asia/Calcutta": "Asia/Kolkata", "Asia/Saigon": "Asia/Ho_Chi_Minh", "Asia/Katmandu": "Asia/Kathmandu", "Europe/Kiev": "Europe/Kyiv", "Asia/Rangoon": "Asia/Yangon" };
export const timeZoneName = (tz: string | null | undefined) => (tz ? (TZ_ALIASES[tz] ?? tz).replace(/_/g, " ") : "Not reported");
/** The region a time zone belongs to: "Asia", "Europe", "America", … */
export const regionOf = (tz: string | null | undefined) => (tz ? (TZ_ALIASES[tz] ?? tz).split("/")[0]!.replace(/_/g, " ") : "Unknown");

/** "34 h 12 min", "12 min", "45 s", "—". */
export function fmtDuration(seconds: number): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${fmtInt(h)} h ${rest} min` : `${fmtInt(h)} h`;
}
export const fmtHours = (seconds: number) => (seconds >= 36 ? `${(seconds / 3600).toFixed(seconds >= 36_000 ? 0 : 1)} h` : fmtDuration(seconds));

/** A proportion bar beside a number (never colour alone: the value is always printed too). */
export function ShareBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="share">
      <span className="share-bar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="share-val">{label}</span>
    </span>
  );
}

/**
 * Active time per day (or week, for long ranges) as bars, with the busiest value labelled. The
 * days come from `from`..`to` so idle days show as gaps rather than disappearing. The bars are
 * decorative for assistive technology; a visually hidden table carries the same numbers.
 */
export function ActivityChart({ daily, from, to, title }: { daily: { day: string; seconds: number; users?: number }[]; from: string; to: string; title: string }) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const days: { day: string; seconds: number; users: number }[] = [];
  const end = new Date(to.slice(0, 10) + "T00:00:00Z");
  for (let d = new Date(from.slice(0, 10) + "T00:00:00Z"); d <= end; d = new Date(d.getTime() + 86_400_000)) {
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, seconds: byDay.get(key)?.seconds ?? 0, users: byDay.get(key)?.users ?? 0 });
  }
  const weekly = days.length > 62;
  const bins: { label: string; seconds: number; users: number }[] = [];
  if (weekly) {
    for (let i = 0; i < days.length; i += 7) {
      const w = days.slice(i, i + 7);
      bins.push({ label: `Week of ${w[0]!.day}`, seconds: w.reduce((n, d) => n + d.seconds, 0), users: Math.max(...w.map((d) => d.users)) });
    }
  } else for (const d of days) bins.push({ label: d.day, seconds: d.seconds, users: d.users });
  const max = Math.max(0, ...bins.map((b) => b.seconds));
  if (!max) return <p className="quota">No measured activity in this range yet.</p>;
  return (
    <figure className="chart" aria-label={title}>
      <table className="visually-hidden">
        <caption>
          {title}, {weekly ? "per week" : "per day"}
        </caption>
        <thead>
          <tr>
            <th scope="col">{weekly ? "Week of" : "Day"}</th>
            <th scope="col">Active time</th>
            <th scope="col">Users</th>
          </tr>
        </thead>
        <tbody>
          {bins.map((b) => (
            <tr key={b.label}>
              <th scope="row">{b.label.replace("Week of ", "")}</th>
              <td>{b.seconds ? fmtDuration(b.seconds) : "None"}</td>
              <td>{fmtInt(b.users)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="chart-bars" aria-hidden="true">
        {bins.map((b) => (
          <span key={b.label} className="chart-bar" title={`${b.label}: ${fmtDuration(b.seconds)}${b.users ? `, ${b.users} user${b.users === 1 ? "" : "s"}` : ""}`}>
            <i style={{ height: `${b.seconds ? Math.max(4, (b.seconds / max) * 100) : 0}%` }} />
          </span>
        ))}
      </div>
      <figcaption className="chart-axis" aria-hidden="true">
        <span>{bins[0]!.label.replace("Week of ", "")}</span>
        <span>
          {weekly ? "Per week" : "Per day"} · busiest {fmtDuration(max)}
        </span>
        <span>{bins[bins.length - 1]!.label.replace("Week of ", "")}</span>
      </figcaption>
    </figure>
  );
}

export type { AppKey };
