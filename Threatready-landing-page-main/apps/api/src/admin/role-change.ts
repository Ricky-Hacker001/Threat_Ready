/**
 * The rules for promoting a user to platform admin or removing it, as a pure decision so they can
 * be unit-tested without a database. AdminService.setRole gathers the facts, calls planRoleChange,
 * then applies the plan in one transaction.
 */

export interface RoleChangeFacts {
  actor: { userId: string };
  target: {
    id: string;
    email: string | null;
    role: string;
    emailVerified: boolean;
    isAnonymous: boolean | null;
    /** True when the email is in ADMIN_EMAILS (admin regardless of the role column). */
    envListed: boolean;
  };
  requested: "admin" | "user";
  /** The email the caller retyped, already trimmed and lower-cased. */
  confirmEmail: string;
  /** Platform admins right now: role = 'admin' plus verified ADMIN_EMAILS accounts not already counted. */
  adminCount: number;
}

export type RoleChangePlan =
  | { ok: true; action: "role.promote" | "role.demote"; signOut: boolean }
  | { ok: false; status: 400 | 409; code: string; message: string };

const refuse = (status: 400 | 409, code: string, message: string): RoleChangePlan => ({ ok: false, status, code, message });

export function planRoleChange(f: RoleChangeFacts): RoleChangePlan {
  const t = f.target;
  if (t.id === f.actor.userId) return refuse(400, "ADMIN_SELF_CHANGE", "You can't change your own role. Ask another admin.");
  if (t.isAnonymous) return refuse(400, "ADMIN_TARGET_TRIAL", "Trial accounts can't be admins. The user needs to create an account first.");
  if (!t.email || t.email.toLowerCase() !== f.confirmEmail) return refuse(400, "ADMIN_CONFIRM_MISMATCH", "The email you typed doesn't match this user.");

  if (f.requested === "admin") {
    if (!t.emailVerified) return refuse(400, "ADMIN_TARGET_UNVERIFIED", "Only a verified email can be made admin. The user needs to verify first.");
    if (t.role === "admin") return refuse(409, "ADMIN_ALREADY", "This user is already an admin.");
    if (t.envListed) return refuse(409, "ADMIN_ALREADY", "This user is already an admin through ADMIN_EMAILS.");
    return { ok: true, action: "role.promote", signOut: false };
  }

  // requested === "user"
  if (t.envListed) return refuse(400, "ADMIN_ENV_LISTED", "This admin is listed in ADMIN_EMAILS. Remove the email from that setting; the console can't override it.");
  if (t.role !== "admin") return refuse(409, "ADMIN_NOT_ADMIN", "This user isn't an admin.");
  if (f.adminCount <= 1) return refuse(400, "ADMIN_LAST_ADMIN", "This is the last admin. Promote someone else before removing this one.");
  // Sign the user out everywhere: the session cookie cache can keep admin rights for up to 5 minutes otherwise.
  return { ok: true, action: "role.demote", signOut: true };
}
