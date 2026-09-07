/** Local start-path profile: planned Convex RTTs + decision-path timing. */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canSkipInboundBind } from "../agent/lib/inbound-bind.ts";
import {
  HANDLE_TENANT_TTL_MS,
  TELEGRAM_TENANT_TTL_MS,
  createTtlCache,
  returningOneToOneConvexHops,
  returningOneToOneConvexRtts,
  returningTelegramConvexRtts,
} from "../agent/lib/inbound-path.ts";

const ITER = 100_000;

function nsPerCall(fn: () => void): number {
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) fn();
  return ((performance.now() - t0) / ITER) * 1e6;
}

const warmOpts = {
  handleCached: true,
  skipGroupLookup: true,
  skipBind: true,
} as const;
const boundUncachedOpts = {
  handleCached: false,
  skipGroupLookup: true,
  skipBind: true,
} as const;
const coldOpts = {
  handleCached: false,
  skipGroupLookup: false,
  skipBind: false,
} as const;

const cache = createTtlCache<string>(HANDLE_TENANT_TTL_MS);
const bound = { phoneE164: "+15551212", inkboxConversationId: "conv-1", status: "active" };

const report = {
  measuredAt: new Date().toISOString(),
  returningOneToOne: {
    warmHandleCachedBound: {
      rtts: returningOneToOneConvexRtts(warmOpts),
      hops: returningOneToOneConvexHops(warmOpts),
    },
    boundHandleUncached: {
      rtts: returningOneToOneConvexRtts(boundUncachedOpts),
      hops: returningOneToOneConvexHops(boundUncachedOpts),
    },
    coldFirstBind: {
      rtts: returningOneToOneConvexRtts(coldOpts),
      hops: returningOneToOneConvexHops(coldOpts),
    },
  },
  returningTelegram: {
    warmRtts: returningTelegramConvexRtts({ telegramCached: true }),
    coldRtts: returningTelegramConvexRtts({ telegramCached: false }),
  },
  ttlMs: {
    handleTenant: HANDLE_TENANT_TTL_MS,
    telegramTenant: TELEGRAM_TENANT_TTL_MS,
  },
  localDecisionNs: {
    ttlCacheGetSet: Math.round(
      nsPerCall(() => {
        cache.set("bro-handle", "tenant");
        cache.get("bro-handle");
      }),
    ),
    canSkipInboundBind: Math.round(
      nsPerCall(() => {
        canSkipInboundBind(bound, bound.phoneE164, bound.inkboxConversationId);
      }),
    ),
    rttPlanner: Math.round(
      nsPerCall(() => {
        returningOneToOneConvexRtts(warmOpts);
      }),
    ),
  },
  note: "Warm returning 1:1 «ок» awaits only countInboundMessage before parkTurn. Handle HMAC tenant is process-cached. Live Inkbox RTT is not included.",
};

const json = `${JSON.stringify(report, null, 2)}\n`;
process.stdout.write(json);

const tmp = join(tmpdir(), `inbound-path-profile-${process.pid}.json`);
writeFileSync(tmp, json);
const outDir = process.env.INBOUND_PATH_PROFILE_DIR ?? "/opt/cursor/artifacts";
try {
  mkdirSync(outDir, { recursive: true });
  copyFileSync(tmp, join(outDir, "inbound-path-profile.json"));
} catch (err) {
  console.error("profile write failed", err);
}
