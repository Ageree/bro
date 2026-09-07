/** Local start-path profile: planned Convex RTTs + decision-path timing. */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchArchive } from "../agent/lib/archive.ts";
import {
  ARCHIVE_RECALL_TIMEOUT_MS,
  CONVERSATION_RECALL_TIMEOUT_MS,
} from "../agent/lib/archive-policy.ts";
import { searchConversation } from "../agent/lib/conversation-recall.ts";
import { conversationScopeKey } from "../agent/lib/eve-scope-key.ts";
import { canSkipInboundBind } from "../agent/lib/inbound-bind.ts";
import {
  HANDLE_TENANT_TTL_MS,
  TELEGRAM_TENANT_TTL_MS,
  createTtlCache,
  returningOneToOneConvexHops,
  returningOneToOneConvexRtts,
  returningTelegramConvexRtts,
} from "../agent/lib/inbound-path.ts";
import {
  INSTINCT_RECALL_TTL_MS,
  instinctScopesForPerson,
  loadInstinctRecall,
} from "../agent/lib/instinct-recall.ts";

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

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ms: number; ok: boolean; error?: string }> {
  const t0 = performance.now();
  try {
    await fn();
    return { ms: Math.round(performance.now() - t0), ok: true };
  } catch (err) {
    return {
      ms: Math.round(performance.now() - t0),
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 180) : String(err),
    };
  }
}

/** Empty throwaway person — measures HTTP RTT, not a real tenant's data. */
async function measureInstinctHttp(): Promise<Record<string, unknown>> {
  if (!process.env.SUPERMEMORY_API_KEY?.trim()) {
    return { skipped: true, reason: "SUPERMEMORY_API_KEY missing" };
  }
  const phone = "+15550001999";
  const query = "ок";
  const scopes = instinctScopesForPerson(phone);
  const digestMs = Math.round(
    nsPerCall(() => {
      conversationScopeKey(phone);
    }) / 1e3,
  );
  const conversation = await timed(() =>
    searchConversation(scopes.conversationScope, query, CONVERSATION_RECALL_TIMEOUT_MS),
  );
  const archive = await timed(() =>
    searchArchive(phone, query, 4, ARCHIVE_RECALL_TIMEOUT_MS),
  );
  const parallel = await timed(() =>
    Promise.all([
      searchConversation(scopes.conversationScope, query, CONVERSATION_RECALL_TIMEOUT_MS),
      searchArchive(phone, query, 4, ARCHIVE_RECALL_TIMEOUT_MS),
    ]),
  );
  const firstPair = await timed(() => loadInstinctRecall(scopes, query));
  const cachedPair = await timed(() => loadInstinctRecall(scopes, query));
  const serialMs = conversation.ms + archive.ms;
  return {
    skipped: false,
    query,
    conversationScopePrefix: scopes.conversationScope.slice(0, 12),
    digestUs: digestMs,
    conversationHttp: conversation,
    archiveHttp: archive,
    parallelHttp: parallel,
    serialSumMs: serialMs,
    overlapSavedMs: Math.max(0, serialMs - parallel.ms),
    loadInstinctRecallMs: firstPair.ms,
    loadInstinctRecallCachedMs: cachedPair.ms,
    budgetMs: ARCHIVE_RECALL_TIMEOUT_MS,
    note: "Empty throwaway containers. Times are Supermemory RTT, not iMessage.",
  };
}

const instinctHttp = await measureInstinctHttp();

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
  instinct: {
    prefetchDuringBilling: true,
    parallelConversationAndArchive: true,
    ttlMs: INSTINCT_RECALL_TTL_MS,
    http: instinctHttp,
  },
  warmPathWithoutIMessage: {
    awaitedConvexHopsBeforeParkTurn: 1,
    convexBillingMs: null,
    convexBillingReason: "CONVEX_URL unset — hop count pinned, RTT not live",
    overlappedDuringBilling: [
      "loadWakeContext",
      "prefetchInstinctRecall",
      "ackIMessageReadAndTyping",
    ],
    remainingAfterParkTurn: [
      "eve session start",
      "OpenRouter first tokens",
      "Inkbox send",
    ],
  },
  note: "No live iMessage. Warm 1:1 awaits one Convex hop; Instinct pair is measured against Supermemory when a key is present.",
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
