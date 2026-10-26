/** Local users and groups (lab-only: passwords are hashed in the browser and never leave it). */
import type { FirewallConfig, LocalUser, UserGroup, UsersConfig } from '../state/types';
import type { AuditInput } from '../state/store';
import { hashPassword, passwordProblems, uid } from '../lib/hash';

type Errors = Record<string, string>;
type Result = { next: FirewallConfig; audit: AuditInput[] };
const USER_RE = /^[a-z][a-z0-9._-]{1,31}$/;

export interface UserForm { id: string; name: string; password: string; confirm: string; groups: string[]; otp: boolean; comment: string }
export const blankUser = (): UserForm => ({ id: '', name: '', password: '', confirm: '', groups: ['Everyone'], otp: false, comment: '' });
export const toForm = (u: LocalUser): UserForm => ({ id: u.id, name: u.name, password: '', confirm: '', groups: u.groups, otp: u.otp, comment: u.comment });

export function validateUser(cfg: FirewallConfig, f: UserForm, originalId: string | null): Errors {
  const e: Errors = {};
  if (!USER_RE.test(f.name)) e.name = 'Use 2–32 lower-case letters, digits, dot, dash or underscore, starting with a letter.';
  else if (cfg.users.local.some((u) => u.name === f.name && u.id !== originalId) || f.name === cfg.system.adminUser) e.name = `User ${f.name} already exists.`;
  if (!originalId || f.password) {
    const p = passwordProblems(f.password, f.name);
    if (p.length) e.password = `Password needs: ${p.join(', ')}.`;
    if (f.confirm !== f.password) e.confirm = 'Passwords do not match.';
  }
  if (f.groups.some((g) => !cfg.users.groups.some((x) => x.name === g))) e.groups = 'Unknown group.';
  return e;
}

/** `passwordHash` is the salted hash of f.password from hashPasswordSecure (the caller awaits it); the legacy digest is only a fallback. */
export function saveUser(cfg: FirewallConfig, f: UserForm, originalId: string | null, passwordHash: string = f.password ? hashPassword(f.password) : ''): Result {
  const before = cfg.users.local.find((u) => u.id === originalId);
  const u: LocalUser = {
    id: f.id || uid(), name: f.name, passwordHash: f.password ? passwordHash : before?.passwordHash ?? '', groups: [...new Set(['Everyone', ...f.groups])],
    otp: f.otp, vpnAccess: before?.vpnAccess ?? [], comment: f.comment,
  };
  const local = originalId ? cfg.users.local.map((x) => (x.id === originalId ? u : x)) : [...cfg.users.local, u];
  return { next: { ...cfg, users: { ...cfg.users, local } }, audit: [{ category: 'Users', action: `Local user ${u.name} ${originalId ? 'modified' : 'added'}`, detail: `Groups: ${u.groups.join(', ')}${u.otp ? '; one-time password required' : ''}${f.password && originalId ? '; password changed' : ''}` }] };
}

/**
 * After a successful simulated login (NetExtender, user login): a local user's hash from an older save (FNV,
 * unsalted SHA-256, fewer iterations) replaced by its salted upgrade, as the administrator's is on login. Only
 * while it is still the hash that was checked; no audit entry, since the administrator changed nothing. Returns
 * the config unchanged when the user is gone, the replacement is empty, or the user already holds that hash.
 */
export function upgradeUserHash(cfg: FirewallConfig, id: string, checked: string, passwordHash: string): FirewallConfig {
  if (!passwordHash || passwordHash === checked) return cfg;
  if (!cfg.users.local.some((u) => u.id === id && u.passwordHash === checked)) return cfg;
  return { ...cfg, users: { ...cfg.users, local: cfg.users.local.map((u) => (u.id === id ? { ...u, passwordHash } : u)) } };
}

export function deleteUser(cfg: FirewallConfig, id: string): Result {
  const u = cfg.users.local.find((x) => x.id === id)!;
  return { next: { ...cfg, users: { ...cfg.users, local: cfg.users.local.filter((x) => x.id !== id) } }, audit: [{ category: 'Users', action: `Local user ${u.name} deleted`, detail: '' }] };
}

export function validateGroup(cfg: FirewallConfig, g: UserGroup, original: string | null): Errors {
  const e: Errors = {};
  if (!/^[A-Za-z][A-Za-z0-9 _.-]{0,31}$/.test(g.name)) e.name = 'Enter a group name, e.g. Staff.';
  else if (cfg.users.groups.some((x) => x.name.toLowerCase() === g.name.toLowerCase() && x.name !== original)) e.name = `Group ${g.name} already exists.`;
  return e;
}

export function saveGroup(cfg: FirewallConfig, g: UserGroup, original: string | null, members: string[]): Result {
  const groups = original ? cfg.users.groups.map((x) => (x.name === original ? { ...g, builtIn: x.builtIn } : x)) : [...cfg.users.groups, { ...g, builtIn: false }];
  const local = cfg.users.local.map((u) => {
    const without = u.groups.filter((x) => x !== original && x !== g.name);
    return { ...u, groups: members.includes(u.name) ? [...without, g.name] : without };
  });
  const rename = (v: string) => (original && v === original ? g.name : v);
  const accessRules = cfg.accessRules.map((r) => ({ ...r, usersIncl: rename(r.usersIncl), usersExcl: rename(r.usersExcl) }));
  return { next: { ...cfg, users: { ...cfg.users, groups, local }, accessRules }, audit: [{ category: 'Users', action: `User group ${g.name} ${original ? 'modified' : 'added'}`, detail: `Members: ${members.join(', ') || 'none'}` }] };
}

export function deleteGroup(cfg: FirewallConfig, name: string): Result & { error?: string } {
  const g = cfg.users.groups.find((x) => x.name === name)!;
  if (g.builtIn) return { next: cfg, audit: [], error: 'Built-in groups cannot be deleted.' };
  if (cfg.accessRules.some((r) => r.usersIncl === name || r.usersExcl === name)) return { next: cfg, audit: [], error: `${name} is used by an access rule.` };
  return {
    next: { ...cfg, users: { ...cfg.users, groups: cfg.users.groups.filter((x) => x.name !== name), local: cfg.users.local.map((u) => ({ ...u, groups: u.groups.filter((x) => x !== name) })) } },
    audit: [{ category: 'Users', action: `User group ${name} deleted`, detail: '' }],
  };
}

export function saveUserSettings(cfg: FirewallConfig, p: Partial<Pick<UsersConfig, 'inactivityMin' | 'redirectToLogin'>>): Result {
  const users = { ...cfg.users, ...p };
  return { next: { ...cfg, users }, audit: [{ category: 'Users', action: 'User settings modified', detail: `Inactivity ${users.inactivityMin} min; redirect unauthenticated users to login ${users.redirectToLogin ? 'on' : 'off'}` }] };
}
