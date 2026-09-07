/** Short-lived tenant / Instinct caches used on the inbound start path. */

export const HANDLE_TENANT_TTL_MS = 30_000;
export const TELEGRAM_TENANT_TTL_MS = 30_000;

export type TtlCacheHit<T> =
  | { hit: true; value: T }
  | { hit: false };

export type TtlCache<T> = {
  get(key: string, now?: number): TtlCacheHit<T>;
  set(key: string, value: T, now?: number): void;
  forget(key: string): void;
  clear(): void;
  size(): number;
};

export function createTtlCache<T>(ttlMs: number): TtlCache<T> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("ttlMs must be a positive finite number");
  }
  const map = new Map<string, { at: number; value: T }>();
  return {
    get(key, now = Date.now()) {
      const row = map.get(key);
      if (!row) return { hit: false };
      if (now - row.at >= ttlMs) {
        map.delete(key);
        return { hit: false };
      }
      return { hit: true, value: row.value };
    },
    set(key, value, now = Date.now()) {
      map.set(key, { at: now, value });
    },
    forget(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}
