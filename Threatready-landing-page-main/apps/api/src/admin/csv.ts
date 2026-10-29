import { APP_KEYS, type AdminUserRow } from "@threatready/contracts";

/**
 * Where a spreadsheet would start evaluating a cell: a leading tab or line break, or a formula
 * character after any whitespace it skips (including no-break and ideographic spaces and zero-width
 * marks). Formula characters: = + - @ and their full-width and small forms, the Unicode minus, and
 * ';' (an argument separator in many locales).
 */
const FORMULA_START = /^(?:[\t\r\n]|[\s​-‍⁠]*[=+\-@;−﹢﹣﹦＋－＝＠])/;

/** A spreadsheet must never evaluate a cell a user controls (names, emails): prefix formula starts. */
export const cell = (v: unknown): string => {
  let t = v === null || v === undefined ? "" : String(v);
  if (FORMULA_START.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function toCsv(rows: AdminUserRow[], range: { from: Date; to: Date }): string {
  const head = [
    "Name", "Email", "Username", "Admin", "Trial", "Email verified", "Account", "Organisation", "Organisation role", "Joined", "Last seen", "Active sessions",
    "Hours used", "Country", "Time zone", "Last app", "Last area", "Last active",
    "LLM calls", "Input tokens", "Output tokens", "Cache tokens", "AI cost (USD)",
    ...APP_KEYS.map((k) => `AI cost ${k} (USD)`),
  ];
  const lines = rows.map((u) => [
    u.name, u.email, u.username, u.isAdmin, u.isTrial, u.emailVerified, u.account.type, u.account.org?.name, u.account.org?.role, u.createdAt, u.lastSeenAt, u.activeSessions,
    (u.seconds / 3600).toFixed(2), u.country, u.timeZone, u.lastApp?.app, u.lastApp?.area, u.lastApp?.at,
    u.ai.calls, u.ai.inputTokens, u.ai.outputTokens, u.ai.cacheReadTokens + u.ai.cacheWriteTokens, u.ai.costUsd.toFixed(4),
    ...APP_KEYS.map((k) => (u.aiByApp[k]?.costUsd ?? 0).toFixed(4)),
  ].map(cell).join(","));
  const note = `# ThreatReady users, ${range.from.toISOString()} to ${range.to.toISOString()}`;
  return [note, head.map(cell).join(","), ...lines].join("\r\n") + "\r\n";
}
