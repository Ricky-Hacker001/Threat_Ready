import { createAuthClient } from "better-auth/react";
import { anonymousClient, emailOTPClient, usernameClient } from "better-auth/client/plugins";

// Same origin as the SPA (Cloudflare routes /api/* to the API; Vite proxies it in dev).
// For a split api.* host set VITE_API_ORIGIN; the API then enables credentialed CORS.
export const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? window.location.origin;

export const authClient = createAuthClient({
  baseURL: `${API_ORIGIN}/api/auth`,
  plugins: [usernameClient(), emailOTPClient(), anonymousClient()],
  fetchOptions: { credentials: "include" },
});

export const { useSession } = authClient;
