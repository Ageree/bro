/** Local start-path profile: HTTP timing without iMessage. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchArchive } from "../agent/lib/archive.ts";
import {
  ARCHIVE_RECALL_TIMEOUT_MS,
  CONVERSATION_RECALL_TIMEOUT_MS,
} from "../agent/lib/archive-policy.ts";
import { searchConversation } from "../agent/lib/conversation-recall.ts";
import { conversationScopeKey } from "../agent/lib/eve-scope-key.ts";
import { agentHandle, inkboxIdentity } from "../agent/lib/inkbox.ts";
import { canSkipInboundBind } from "../agent/lib/inbound-bind.ts";
import {
  HANDLE_TENANT_TTL_MS,
  TELEGRAM_TENANT_TTL_MS,
  createTtlCache,
} from "../agent/lib/inbound-path.ts";
import {
  INSTINCT_RECALL_TTL_MS,
  instinctScopesForPerson,
  loadInstinctRecall,
} from "../agent/lib/instinct-recall.ts";
import { DEFAULT_OPENROUTER_MODEL } from "../agent/lib/model.ts";
import { withOpenRouterChatDefaults } from "../agent/lib/openrouter-chat.ts";
import {
  OPENROUTER_AUTH_URL,
  OPENROUTER_CHAT_URL,
  canPrefetchOpenRouter,
} from "../agent/lib/openrouter-warm.ts";

const ITER = 100_000;

/** Scan OpenRouter chat SSE enough to time first reasoning vs first visible token. */
function openRouterStreamProgress(buf: string) {
  let reasoning = false;
  let content = false;
  let hasSseData = /(?:^|\n)data:/.test(buf);
  for (const line of buf.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    hasSseData = true;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const d = (JSON.parse(payload) as { choices?: Array<{ delta?: Record<string, unknown> }> })
        .choices?.[0]?.delta;
      if (typeof d?.reasoning === "string" && d.reasoning) reasoning = true;
      if (typeof d?.content === "string" && d.content) content = true;
    } catch {
      continue;
    }
  }
  return { hasSseData, reasoning, content };
}

function nsPerCall(fn: () => void): number {
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) fn();
  return ((performance.now() - t0) / ITER) * 1e6;
}

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
  const digestUs = Math.round(
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
    digestUs,
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

/** Stream TTFB against the live Bro model. No Eve tools, no Inkbox send. */
async function measureOpenRouterTtfb(): Promise<Record<string, unknown>> {
  if (!canPrefetchOpenRouter()) {
    return { skipped: true, reason: "OPENROUTER_API_KEY missing" };
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return { skipped: true, reason: "OPENROUTER_API_KEY missing" };
  const model = process.env.BRO_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const instructions = readFileSync(
    new URL("../agent/instructions.md", import.meta.url),
    "utf8",
  );
  const prefetch = await timed(() =>
    fetch(OPENROUTER_AUTH_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`auth ${res.status}`);
    }),
  );

  async function streamOnce(): Promise<Record<string, unknown>> {
    const t0 = performance.now();
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        withOpenRouterChatDefaults({
          model,
          stream: true,
          max_tokens: 1024,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: "ок" },
          ],
        }),
      ),
      signal: AbortSignal.timeout(45_000),
    });
    const headersMs = Math.round(performance.now() - t0);
    if (!res.ok || !res.body) {
      const err = await res.text().catch(() => "");
      return {
        ok: false,
        headersMs,
        status: res.status,
        error: err.slice(0, 180),
      };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let firstSseMs: number | null = null;
    let firstReasoningMs: number | null = null;
    let firstContentMs: number | null = null;
    try {
      while (firstContentMs === null) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const seen = openRouterStreamProgress(buf);
        if (seen.hasSseData && firstSseMs === null) {
          firstSseMs = Math.round(performance.now() - t0);
        }
        if (seen.reasoning && firstReasoningMs === null) {
          firstReasoningMs = Math.round(performance.now() - t0);
        }
        if (seen.content) {
          firstContentMs = Math.round(performance.now() - t0);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return {
      ok: firstContentMs !== null,
      headersMs,
      firstSseMs,
      firstReasoningMs,
      firstContentMs,
      bytesBeforeContent: buf.length,
    };
  }

  const afterPrefetch = await streamOnce();
  const repeat = await streamOnce();
  return {
    skipped: false,
    model,
    instructionChars: instructions.length,
    probeMaxTokens: 1024,
    productionExtras: withOpenRouterChatDefaults({}),
    prefetchAuth: prefetch,
    streamAfterPrefetch: afterPrefetch,
    streamRepeat: repeat,
    note: "Probe uses production OpenRouter extras (reasoning.effort=low, provider.sort=latency). Eve reasoning stays unset. No Eve tools. Production maxOutputTokens stays 8192. No iMessage send.",
  };
}

async function measureInkboxIdentity(): Promise<Record<string, unknown>> {
  if (!process.env.INKBOX_API_KEY?.trim()) {
    return { skipped: true, reason: "INKBOX_API_KEY missing" };
  }
  const handle = agentHandle();
  const first = await timed(() => inkboxIdentity(handle));
  const cached = await timed(() => inkboxIdentity(handle));
  return {
    skipped: false,
    handle,
    identityGetMs: first.ms,
    identityGetOk: first.ok,
    identityGetError: first.error,
    identityCachedMs: cached.ms,
    note: "Identity GET only. No markRead, typing, or send — those need a live conversation.",
  };
}

const inkboxIdentityHttp = await measureInkboxIdentity();
const instinctHttp = await measureInstinctHttp();
const openrouter = await measureOpenRouterTtfb();

const report = {
  measuredAt: new Date().toISOString(),
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
  },
  instinct: {
    prefetchDuringBilling: true,
    parallelConversationAndArchive: true,
    ttlMs: INSTINCT_RECALL_TTL_MS,
    http: instinctHttp,
  },
  openrouter,
  inkboxIdentity: inkboxIdentityHttp,
  warmPathWithoutIMessage: {
    awaitedConvexHopsBeforeParkTurn: 1,
    convexBillingMs: null,
    convexBillingReason: "CONVEX_URL unset — hop count pinned, RTT not live",
    overlappedDuringBilling: [
      "loadWakeContext",
      "prefetchInstinctRecall",
      "prefetchOpenRouter",
      "ackIMessageReadAndTyping",
    ],
    remainingAfterParkTurn: [
      "eve session start",
      "OpenRouter first tokens (measured here as stream TTFB)",
      "Inkbox send (not measured — no live conversation)",
    ],
  },
  note: "No live iMessage send. Warm 1:1 awaits one Convex hop; Instinct and OpenRouter TTFB are live HTTP when keys are present.",
};

const json = `${JSON.stringify(report, null, 2)}\n`;
process.stdout.write(json);

const tmp = join(tmpdir(), `inbound-path-profile-${process.pid}.json`);
writeFileSync(tmp, json);
const outDir = process.env.INBOUND_PATH_PROFILE_DIR ?? "/opt/cursor/artifacts";
try {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "inbound-path-profile.json"), json);
} catch (err) {
  console.error("profile write failed", err);
}
