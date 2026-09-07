/** Planned Convex hops before parkTurn — keep the returning 1:1 path to billing only. */

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

export type InboundConvexHop =
  | "getTenantByHandle"
  | "getGroupByConversation"
  | "bindInbound"
  | "countInboundMessage";

export type ReturningOneToOneOpts = {
  handleCached: boolean;
  skipGroupLookup: boolean;
  skipBind: boolean;
};

/** Serial Convex calls a 1:1 iMessage inbound still awaits before parkTurn. */
export function returningOneToOneConvexHops(
  opts: ReturningOneToOneOpts,
): InboundConvexHop[] {
  const hops: InboundConvexHop[] = [];
  if (!opts.handleCached) hops.push("getTenantByHandle");
  if (!opts.skipGroupLookup) hops.push("getGroupByConversation");
  if (!opts.skipBind) hops.push("bindInbound");
  hops.push("countInboundMessage");
  return hops;
}

export function returningOneToOneConvexRtts(opts: ReturningOneToOneOpts): number {
  return returningOneToOneConvexHops(opts).length;
}

export function returningTelegramConvexRtts(opts: {
  telegramCached: boolean;
}): number {
  return (opts.telegramCached ? 0 : 1) + 1;
}
