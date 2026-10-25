import { OTP_TTL_SECONDS } from "@threatready/contracts";
import type { EmailMessage } from "./email.port.js";

const minutes = Math.round(OTP_TTL_SECONDS / 60);

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0">
<tr><td style="padding:28px 28px 8px;font-weight:700;font-size:15px;letter-spacing:.02em">ThreatReady</td></tr>
<tr><td style="padding:8px 28px 4px;font-size:20px;font-weight:600">${escape(title)}</td></tr>
<tr><td style="padding:8px 28px 28px;font-size:15px;line-height:1.55;color:#334155">${bodyHtml}</td></tr>
</table>
<p style="font-size:12px;color:#64748b;margin:16px 0 0">Aerovant Technologies · Krishnagiri, Tamil Nadu</p>
</td></tr></table></body></html>`;
}

const ignoreLine = "If you didn't request this, you can ignore this email. Your account is unchanged.";

type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

const otpCopy: Record<OtpType, { subject: string; title: string; lead: string }> = {
  "email-verification": {
    subject: "Verify your ThreatReady email",
    title: "Verify your email",
    lead: "Use this code to finish creating your ThreatReady account.",
  },
  "forget-password": {
    subject: "Reset your ThreatReady password",
    title: "Reset your password",
    lead: "Use this code to set a new ThreatReady password.",
  },
  "sign-in": {
    subject: "Your ThreatReady sign-in code",
    title: "Sign-in code",
    lead: "Use this code to sign in to ThreatReady.",
  },
  "change-email": {
    subject: "Confirm your new ThreatReady email",
    title: "Confirm your new email",
    lead: "Use this code to confirm your new email address.",
  },
};

export function otpEmail(to: string, otp: string, type: OtpType): EmailMessage {
  const c = otpCopy[type];
  const text = `${c.lead}\n\nCode: ${otp}\n\nIt expires in ${minutes} minutes. Never share it with anyone, including ThreatReady staff.\n\n${ignoreLine}`;
  const html = layout(
    c.title,
    `<p style="margin:0 0 16px">${escape(c.lead)}</p>
<p style="margin:0 0 16px;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:.3em;color:#0f172a">${escape(otp)}</p>
<p style="margin:0 0 16px">It expires in ${minutes} minutes. Never share it with anyone, including ThreatReady staff.</p>
<p style="margin:0;color:#64748b;font-size:13px">${escape(ignoreLine)}</p>`,
  );
  return { to, subject: c.subject, text, html, kind: `otp:${type}` };
}

export function usernameReminderEmail(to: string, username: string, loginUrl: string): EmailMessage {
  const text = `You asked for your ThreatReady username.\n\nUsername: ${username}\n\nSign in: ${loginUrl}\n\n${ignoreLine}`;
  const html = layout(
    "Your username",
    `<p style="margin:0 0 16px">You asked for your ThreatReady username.</p>
<p style="margin:0 0 16px;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:20px;font-weight:700">${escape(username)}</p>
<p style="margin:0 0 16px"><a href="${escape(loginUrl)}" style="color:#0e7490">Sign in to ThreatReady</a></p>
<p style="margin:0;color:#64748b;font-size:13px">${escape(ignoreLine)}</p>`,
  );
  return { to, subject: "Your ThreatReady username", text, html, kind: "username-reminder" };
}

export function existingAccountEmail(to: string, loginUrl: string): EmailMessage {
  const lead = "Someone tried to create a ThreatReady account with this email, but it already has one.";
  const text = `${lead}\n\nIf that was you, sign in instead or use "Forgot password": ${loginUrl}\n\n${ignoreLine}`;
  const html = layout(
    "You already have an account",
    `<p style="margin:0 0 16px">${escape(lead)}</p>
<p style="margin:0 0 16px">If that was you, <a href="${escape(loginUrl)}" style="color:#0e7490">sign in</a> or use “Forgot password”.</p>
<p style="margin:0;color:#64748b;font-size:13px">${escape(ignoreLine)}</p>`,
  );
  return { to, subject: "Your ThreatReady account", text, html, kind: "existing-account" };
}

/** Sent once when repeated wrong passwords lock an account's sign-in (auth.ts lockout). */
export function signInLockedEmail(to: string, minutes: number, loginUrl: string): EmailMessage {
  const lead = `There were several wrong passwords for your ThreatReady username, so password sign-in is paused for ${minutes} minutes.`;
  const next = "If that was you, wait and try again, or reset your password from the sign-in page now. If it wasn't, reset your password: the person trying doesn't know it, and the lock protects you meanwhile.";
  const text = `${lead}\n\n${next}\n\nSign in: ${loginUrl}`;
  const html = layout(
    "Sign-in paused",
    `<p style="margin:0 0 16px">${escape(lead)}</p>
<p style="margin:0 0 16px">${escape(next)}</p>
<p style="margin:0"><a href="${escape(loginUrl)}" style="color:#0e7490">Go to sign in</a></p>`,
  );
  return { to, subject: "Sign-in to your ThreatReady account was paused", text, html, kind: "signin-locked" };
}
