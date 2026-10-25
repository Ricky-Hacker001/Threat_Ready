import type { FirewallConfig, NetInterface } from '../state/types';
import type { AuditInput } from '../state/store';
import { hashPassword, passwordProblems } from '../lib/hash';
import { validateInterface } from './interfaceService';

export interface SetupInput {
  adminUser: string;
  password: string;
  confirm: string;
  hostname: string;
  timezone: string;
  wanMode: 'dhcp' | 'static';
  wanIp: string;
  wanMask: string;
  wanGw: string;
  dns1: string;
  dns2: string;
}

export const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

export function validateCredentials(i: SetupInput): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^[A-Za-z][A-Za-z0-9._-]{2,31}$/.test(i.adminUser)) e.adminUser = 'Use 3–32 letters, digits, dot, dash or underscore, starting with a letter.';
  const problems = passwordProblems(i.password, i.adminUser);
  if (problems.length) e.password = `Password still needs: ${problems.join(', ').toLowerCase()}.`;
  if (i.confirm !== i.password) e.confirm = 'The two passwords do not match.';
  return e;
}

export function validateAppliance(i: SetupInput): Record<string, string> {
  const e: Record<string, string> = {};
  if (!HOSTNAME_RE.test(i.hostname)) e.hostname = 'Use letters, digits and dashes only (no spaces), up to 63 characters.';
  return e;
}

export function wanDraft(cfg: FirewallConfig, i: SetupInput): NetInterface {
  const x1 = cfg.interfaces.find((x) => x.name === 'X1')!;
  return i.wanMode === 'dhcp'
    ? { ...x1, zone: 'WAN', mode: 'dhcp', ip: '0.0.0.0', mask: '0.0.0.0', gateway: '0.0.0.0' }
    : { ...x1, zone: 'WAN', mode: 'static', ip: i.wanIp.trim(), mask: i.wanMask.trim(), gateway: i.wanGw.trim(), dns: [i.dns1.trim() || '0.0.0.0', i.dns2.trim() || '0.0.0.0', '0.0.0.0'] };
}

export function validateWan(cfg: FirewallConfig, i: SetupInput): { errors: Record<string, string>; warnings: string[] } {
  if (i.wanMode === 'dhcp') return { errors: {}, warnings: ['The lab ISP does not offer DHCP. X1 will stay at 0.0.0.0 until you set the static address in task 1.1.'] };
  return validateInterface(cfg, wanDraft(cfg, i));
}

/** `passwordHash` is the salted hash from hashPasswordSecure (the caller awaits it); the legacy digest is only a fallback. */
export function applySetup(cfg: FirewallConfig, i: SetupInput, passwordHash: string = hashPassword(i.password)): { next: FirewallConfig; audit: AuditInput[] } {
  const x1 = wanDraft(cfg, i);
  const next: FirewallConfig = {
    ...cfg,
    system: {
      ...cfg.system,
      adminUser: i.adminUser,
      adminPasswordHash: passwordHash,
      defaultPassword: false,
      hostname: i.hostname,
      timezone: i.timezone,
      setupComplete: true,
    },
    interfaces: cfg.interfaces.map((x) => (x.name === 'X1' ? x1 : x)),
  };
  return {
    next,
    audit: [
      { category: 'System', action: 'Setup Guide completed', detail: `Hostname ${i.hostname}, time zone ${i.timezone}` },
      { category: 'Users', action: 'Administrator password changed', detail: `Default password replaced for ${i.adminUser}` },
      { category: 'Network', action: 'Interface X1 configured', detail: i.wanMode === 'dhcp' ? 'WAN set to DHCP' : `WAN static ${i.wanIp}/${i.wanMask}, gateway ${i.wanGw}` },
    ],
  };
}

export const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC'];
