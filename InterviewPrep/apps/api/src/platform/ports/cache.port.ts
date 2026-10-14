/** ADD §6 CachePort; the in-memory adapter backs tier-2 rate limits until Valkey (L11). */
export interface CachePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSec: number): Promise<void>;
  incr(key: string, windowSec: number): Promise<number>;
  del(key: string): Promise<void>;
}

export const CACHE_PORT = Symbol('CachePort');
