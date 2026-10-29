import type {
  AdminOrgDetail,
  AdminOrgList,
  AdminOrgPlan,
  AdminOrgRow,
  AdminOrgStatus,
  AdminOverview,
  AdminRoleChange,
  AdminRoleChangeResult,
  AdminUserDetail,
  AdminUserList,
  AppInfo,
  FeatureKey,
  FeatureState,
  GenericAccepted,
  InvitationAcceptResult,
  InvitationPreview,
  LaunchResponse,
  Me,
  OrgAuditRow,
  OrgCreate,
  OrgInvitationRow,
  OrgInviteCreate,
  OrgInviteResult,
  OrgMemberDetail,
  OrgMemberList,
  OrgMemberRole,
  OrgMemberStatusChange,
  OrgOverview,
  OrgSummary,
  OrgUpdate,
  Overview,
} from "@threatready/contracts";
import { API_ORIGIN } from "./auth-client";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds until a 429 lifts (body retryAfter or Retry-After), for messageFor. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_ORIGIN}/api${path}`, {
      method,
      credentials: "include",
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach ThreatReady. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const retryAfter = Number(data?.retryAfter ?? res.headers.get("retry-after")) || undefined;
    throw new ApiError(
      res.status,
      typeof data?.code === "string" ? data.code : "ERROR",
      typeof data?.message === "string" ? data.message : "Request failed",
      retryAfter,
    );
  }
  return data as T;
}

/**
 * Fetch a file the API serves as an attachment and hand it to the browser as a download. Exports are
 * audited reads, so the API accepts them only as the console's own fetch (Fetch Metadata same-origin,
 * not a document navigation) — a plain link would also follow from any page that linked to it.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_ORIGIN}/api${path}`, { credentials: "include" });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach ThreatReady. Check your connection and try again.");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const retryAfter = Number(data?.retryAfter ?? res.headers.get("retry-after")) || undefined;
    throw new ApiError(res.status, typeof data?.code === "string" ? data.code : "ERROR", typeof data?.message === "string" ? data.message : "Download failed", retryAfter);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export interface PublicConfig {
  providers: { google: boolean; github: boolean };
  turnstileSiteKey: string | null;
  /** "Continue as a guest" offered (server TRIAL_ENABLED); absent from older APIs = off. */
  trialEnabled?: boolean;
  apps: AppInfo[];
  appOrigins: string[];
}

export interface AdminRange {
  from?: string;
  to?: string;
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const api = {
  config: () => request<PublicConfig>("GET", "/public/config"),
  me: () => request<Me>("GET", "/me"),
  feature: (key: FeatureKey) => request<FeatureState>("GET", `/features/${key}`),
  launch: (key: FeatureKey) => request<LaunchResponse>("POST", `/features/${key}/launch`),
  overview: () => request<Overview>("GET", "/overview"),
  admin: {
    overview: (r: AdminRange) => request<AdminOverview>("GET", `/admin/overview${qs({ ...r })}`),
    users: (r: AdminRange & { q?: string; sort?: string; includeTrial?: boolean; account?: string; page?: number; size?: number }) =>
      request<AdminUserList>("GET", `/admin/users${qs({ ...r })}`),
    user: (id: string, r: AdminRange) => request<AdminUserDetail>("GET", `/admin/users/${encodeURIComponent(id)}${qs({ ...r })}`),
    setRole: (id: string, body: AdminRoleChange) => request<AdminRoleChangeResult>("POST", `/admin/users/${encodeURIComponent(id)}/role`, body),
    orgs: (r: AdminRange & { q?: string; status?: string; sort?: string }) => request<AdminOrgList>("GET", `/admin/orgs${qs({ ...r })}`),
    org: (id: string, r: AdminRange) => request<AdminOrgDetail>("GET", `/admin/orgs/${encodeURIComponent(id)}${qs({ ...r })}`),
    setOrgPlan: (id: string, body: AdminOrgPlan) => request<AdminOrgRow>("POST", `/admin/orgs/${encodeURIComponent(id)}/plan`, body),
    setOrgStatus: (id: string, body: AdminOrgStatus) => request<AdminOrgRow>("POST", `/admin/orgs/${encodeURIComponent(id)}/status`, body),
  },
  org: {
    create: (body: OrgCreate) => request<OrgSummary>("POST", "/org", body),
    overview: () => request<OrgOverview>("GET", "/org"),
    update: (body: OrgUpdate) => request<OrgSummary>("PATCH", "/org", body),
    members: () => request<OrgMemberList>("GET", "/org/members"),
    member: (userId: string) => request<OrgMemberDetail>("GET", `/org/members/${encodeURIComponent(userId)}/summary`),
    setRole: (userId: string, body: OrgMemberRole) => request<{ userId: string }>("POST", `/org/members/${encodeURIComponent(userId)}/role`, body),
    setStatus: (userId: string, body: OrgMemberStatusChange) => request<{ userId: string }>("POST", `/org/members/${encodeURIComponent(userId)}/status`, body),
    remove: (userId: string) => request<{ userId: string }>("DELETE", `/org/members/${encodeURIComponent(userId)}`),
    invite: (body: OrgInviteCreate) => request<OrgInviteResult>("POST", "/org/invitations", body),
    resend: (id: string) => request<OrgInvitationRow>("POST", `/org/invitations/${encodeURIComponent(id)}/resend`),
    revoke: (id: string) => request<{ revoked: true }>("DELETE", `/org/invitations/${encodeURIComponent(id)}`),
    audit: () => request<OrgAuditRow[]>("GET", "/org/audit"),
    leave: () => request<{ left: true }>("POST", "/org/leave"),
  },
  invitation: {
    preview: (token: string) => request<InvitationPreview>("GET", `/invitations/${encodeURIComponent(token)}`),
    accept: (token: string) => request<InvitationAcceptResult>("POST", `/invitations/${encodeURIComponent(token)}/accept`),
  },
  forgotUsername: (email: string, captcha?: string) =>
    request<GenericAccepted>("POST", "/account/forgot-username", { email }, captcha ? { "x-captcha-response": captcha } : {}),
};
