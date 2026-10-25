import type { Me } from '@threatready/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';

/**
 * Sign-in lives on onboard.threatready.io, the ThreatReady identity provider. The session cookie
 * is shared across *.threatready.io (localhost cookies ignore the port in development), so this
 * app only asks the API who is signed in and sends everyone else to onboard and back.
 */
export const ONBOARD_URL = (import.meta.env.VITE_ONBOARD_URL as string | undefined) ?? 'http://localhost:5173';

const onboard = (path: string, next = window.location.href) => `${ONBOARD_URL.replace(/\/+$/, '')}${path}?next=${encodeURIComponent(next)}`;

/** Sign in on onboard, then come back to this exact page. */
export function redirectToSignIn(): void {
  window.location.assign(onboard('/'));
}

/** A trial session (no account) can't use InterviewPrep: create an account on onboard. */
export function redirectToSignUp(): void {
  window.location.assign(`${onboard('/')}&mode=signup`);
}

/** One sign-out for every ThreatReady app. */
export function signOut(): void {
  window.location.assign(onboard('/signout', `${window.location.origin}/interview-prep`));
}

export const onboardLinks = {
  home: `${ONBOARD_URL.replace(/\/+$/, '')}/app`,
  profile: `${ONBOARD_URL.replace(/\/+$/, '')}/app/profile`,
};

/**
 * The signed-in user, or `data: null` when there is no session. The API client already retries a
 * network failure twice, so the query itself does not retry, and a component mounting after a failure
 * (RequireAuth) does not refetch it: the shell shows the error with "Try again" instead of a loader
 * that keeps re-asking a server that is down.
 */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
    retryOnMount: false,
  });
}
