import { userKey } from '../platform';

/** Un-namespaced keys used before progress was kept per ThreatReady user (still used standalone). */
const LAB_STATE = 'threatwall:lab-state';
const LAST_ROUTE = 'tw-last-route';
export const LEGACY_STORAGE_KEYS = [LAB_STATE, LAST_ROUTE];
/** The shared backup of an unreadable save: whose it was is unknown, so it is dropped, never migrated to an account. */
export const LEGACY_DISCARD_KEYS = [`${LAB_STATE}:backup`];

/** The lab state (configuration, session, progress) for the current learner. */
export const labStateKey = () => userKey(LAB_STATE);
/** Where "Continue" returns to, for the current learner. */
export const lastRouteKey = () => userKey(LAST_ROUTE);
/** A copy of saved state that could not be loaded (older STATE_VERSION or unreadable), kept instead of discarded. */
export const backupKey = () => `${labStateKey()}:backup`;

/** Every read and write of these keys goes through this store (localStorage, or this tab's memory). */
export { labStorage } from '../platform';
