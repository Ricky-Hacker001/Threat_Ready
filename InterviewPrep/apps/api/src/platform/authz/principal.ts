import type { Permission } from '@threatready/contracts';

export type MembershipRole = 'learner' | 'student' | 'instructor' | 'org_admin';

/** Who is calling (L7 chain steps 1-3). The org id is never read from the request body. */
export interface Principal {
  userId: string;
  sessionId: string;
  orgId: string;
  role: MembershipRole;
  isStaff: boolean;
  email: string;
  name: string;
  /** Profile photo from the identity provider (Google/GitHub), if any */
  image?: string | null;
}

/** Static role-to-permission map. A route that declares no permission is refused. */
export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  learner: ['document:write', 'document:read', 'interview:create', 'interview:read', 'interview:take', 'report:read', 'skills:read'],
  student: ['document:write', 'document:read', 'interview:create', 'interview:read', 'interview:take', 'report:read', 'skills:read'],
  instructor: ['document:read', 'interview:read', 'report:read', 'skills:read'],
  org_admin: ['document:read', 'interview:read', 'report:read', 'skills:read'],
};

export const hasPermission = (p: Principal, perm: Permission): boolean => ROLE_PERMISSIONS[p.role].includes(perm);
