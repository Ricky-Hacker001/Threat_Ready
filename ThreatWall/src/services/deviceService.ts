import type { ConfigBackup, FirewallConfig, SystemSettings } from '../state/types';
import type { AuditInput } from '../state/store';
import { hashPasswordSecure, passwordProblems, uid, verifyPassword } from '../lib/hash';
import { HOSTNAME_RE } from './setupService';

/* ---------- Licensing (task 0.5) ---------- */
export function validateRegistration(cfg: FirewallConfig, f: { email: string; serial: string; authCode: string }): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) e.email = 'Enter the email address of your portal account.';
  if (f.serial.trim().toUpperCase() !== cfg.system.serial) e.serial = 'The serial number must match the one on HOME | Dashboard.';
  if (f.authCode.trim().toUpperCase() !== cfg.system.authCode) e.authCode = 'The authentication code must match the one on HOME | Dashboard.';
  return e;
}

export function register(cfg: FirewallConfig, email: string): { next: FirewallConfig; audit: AuditInput[] } {
  const exp = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
  return {
    next: {
      ...cfg,
      licensing: {
        registered: true,
        account: email,
        registeredAt: Date.now(),
        services: cfg.licensing.services.map((s) => ({ ...s, status: 'licensed', expires: exp })),
      },
    },
    audit: [{ category: 'System', action: 'Appliance registered', detail: `Serial ${cfg.system.serial} registered to ${email}; ${cfg.licensing.services.length} services licensed until ${exp}` }],
  };
}

export function isLicensed(cfg: FirewallConfig, id: string): boolean {
  return cfg.licensing.services.some((s) => s.id === id && s.status === 'licensed');
}

/* ---------- Administration (task 0.7) ---------- */
export type AdminForm = Pick<SystemSettings, 'hostname' | 'domain' | 'description' | 'adminUser' | 'adminTimeoutMin' | 'otpMethod' | 'lockout' | 'httpsPort' | 'certificate'>;

export function validateAdmin(f: AdminForm): Record<string, string> {
  const e: Record<string, string> = {};
  if (!HOSTNAME_RE.test(f.hostname)) e.hostname = 'Use letters, digits and dashes only (no spaces), up to 63 characters.';
  if (f.domain && !/^[A-Za-z0-9.-]{1,253}$/.test(f.domain)) e.domain = 'Enter a valid domain name.';
  if (!/^[A-Za-z][A-Za-z0-9._-]{2,31}$/.test(f.adminUser)) e.adminUser = 'Use 3–32 letters, digits, dot, dash or underscore.';
  if (!Number.isInteger(f.adminTimeoutMin) || f.adminTimeoutMin < 1 || f.adminTimeoutMin > 9999) e.adminTimeoutMin = 'Enter whole minutes from 1 to 9999.';
  if (f.lockout.enabled && !(f.lockout.attempts >= 1 && f.lockout.attempts <= 99)) e.attempts = 'Attempts 1–99.';
  if (f.lockout.enabled && !(f.lockout.minutes >= 1 && f.lockout.minutes <= 9999)) e.minutes = 'Lockout minutes 1–9999.';
  if (!(f.httpsPort >= 1 && f.httpsPort <= 65535)) e.httpsPort = 'Port 1–65535.';
  else if ([22, 80, 4433].includes(f.httpsPort)) e.httpsPort = `Port ${f.httpsPort} is used by another service.`;
  return e;
}

export function applyAdmin(cfg: FirewallConfig, f: AdminForm): { next: FirewallConfig; audit: AuditInput[] } {
  const s = cfg.system;
  const changes: string[] = [];
  if (s.hostname !== f.hostname) changes.push(`firewall name ${s.hostname} → ${f.hostname}`);
  if (s.domain !== f.domain) changes.push(`domain ${f.domain}`);
  if (s.adminUser !== f.adminUser) changes.push(`admin login name ${s.adminUser} → ${f.adminUser}`);
  if (s.adminTimeoutMin !== f.adminTimeoutMin) changes.push(`admin inactivity timeout ${s.adminTimeoutMin} → ${f.adminTimeoutMin} min`);
  if (s.otpMethod !== f.otpMethod) changes.push(`one-time password ${f.otpMethod}`);
  if (s.description !== f.description) changes.push('description updated');
  if (JSON.stringify(s.lockout) !== JSON.stringify(f.lockout)) changes.push(f.lockout.enabled ? `lockout after ${f.lockout.attempts} failed logins for ${f.lockout.minutes} min` : 'login lockout disabled');
  if (s.httpsPort !== f.httpsPort) changes.push(`HTTPS management port ${s.httpsPort} → ${f.httpsPort}`);
  if (s.certificate !== f.certificate) changes.push(`management certificate → ${f.certificate}`);
  return {
    next: { ...cfg, system: { ...s, ...f } },
    audit: [{ category: 'System', action: 'Administration settings modified', detail: changes.join('; ') || 'no changes' }],
  };
}

export async function changePassword(cfg: FirewallConfig, current: string, next: string, confirm: string): Promise<{ error?: string; result?: { next: FirewallConfig; audit: AuditInput[] } }> {
  if (!(await verifyPassword(current, cfg.system.adminPasswordHash)).ok) return { error: 'The current password is incorrect.' };
  const p = passwordProblems(next, cfg.system.adminUser);
  if (p.length) return { error: `New password still needs: ${p.join(', ').toLowerCase()}.` };
  if (next !== confirm) return { error: 'The new passwords do not match.' };
  return {
    result: {
      next: { ...cfg, system: { ...cfg.system, adminPasswordHash: await hashPasswordSecure(next), defaultPassword: false } },
      audit: [{ category: 'Users', action: 'Administrator password changed', detail: cfg.system.adminUser }],
    },
  };
}

/* ---------- Backups (task 0.6) ---------- */
function configWithoutBackups(cfg: FirewallConfig): FirewallConfig {
  return { ...cfg, backups: [] };
}

export function createBackup(cfg: FirewallConfig, user: string, comment: string): { next: FirewallConfig; audit: AuditInput[] } {
  const b: ConfigBackup = {
    id: uid(), createdAt: Date.now(), firmware: cfg.system.firmware, user, comment: comment || 'Local backup', kind: 'local',
    snapshot: JSON.stringify(configWithoutBackups(cfg)),
  };
  const backups = [b, ...cfg.backups].slice(0, 10);
  return { next: { ...cfg, backups }, audit: [{ category: 'System', action: 'Local backup created', detail: b.comment }] };
}

export function restoreBackup(cfg: FirewallConfig, id: string): { next: FirewallConfig; audit: AuditInput[] } | null {
  const b = cfg.backups.find((x) => x.id === id);
  if (!b) return null;
  const restored = JSON.parse(b.snapshot) as FirewallConfig;
  return {
    next: { ...restored, backups: cfg.backups },
    audit: [{ category: 'System', action: 'Configuration restored from local backup', detail: `${b.comment} (${new Date(b.createdAt).toLocaleString()})` }],
  };
}

export function deleteBackup(cfg: FirewallConfig, id: string): { next: FirewallConfig; audit: AuditInput[] } {
  const b = cfg.backups.find((x) => x.id === id);
  return { next: { ...cfg, backups: cfg.backups.filter((x) => x.id !== id) }, audit: [{ category: 'System', action: 'Local backup deleted', detail: b?.comment ?? '' }] };
}

export function exportFile(cfg: FirewallConfig): { name: string; body: string } {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const body = JSON.stringify({
    _notice: 'LAB CONFIGURATION EXPORT — ThreatWall training simulator. Not a real appliance configuration file.',
    exportedAt: new Date().toISOString(),
    config: configWithoutBackups({ ...cfg, system: { ...cfg.system, adminPasswordHash: '(removed)' } }),
  }, null, 2);
  return { name: `threatwall-lab-${cfg.system.hostname}-${stamp}.exp`, body };
}
