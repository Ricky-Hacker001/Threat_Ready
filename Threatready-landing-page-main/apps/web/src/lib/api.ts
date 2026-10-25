import type {
  AdminOverview,
  AdminRoleChange,
  AdminRoleChangeResult,
  AdminUserDetail,
  AdminUserList,
  AppInfo,
  FeatureKey,
  FeatureState,
  GenericAccepted,
  LaunchResponse,
  Me,
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
    users: (r: AdminRange & { q?: string; sort?: string; includeTrial?: boolean; page?: number; size?: number }) =>
      request<AdminUserList>("GET", `/admin/users${qs({ ...r })}`),
    user: (id: string, r: AdminRange) => request<AdminUserDetail>("GET", `/admin/users/${encodeURIComponent(id)}${qs({ ...r })}`),
    setRole: (id: string, body: AdminRoleChange) => request<AdminRoleChangeResult>("POST", `/admin/users/${encodeURIComponent(id)}/role`, body),
  },
  forgotUsername: (email: string, captcha?: string) =>
    request<GenericAccepted>("POST", "/account/forgot-username", { email }, captcha ? { "x-captcha-response": captcha } : {}),
};
