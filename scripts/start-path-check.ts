/** Pins the turn.started critical path so serial Convex/HTTP does not creep back. */
import { readFileSync } from "node:fs";
import { canSkipInboundBind } from "../agent/lib/inbound-bind.ts";
import {
  CONVERSATION_RECALL_TIMEOUT_MS,
  withRecallBudget,
} from "../agent/lib/archive-policy.ts";
import {
  HANDLE_TENANT_TTL_MS,
  TELEGRAM_TENANT_TTL_MS,
  createTtlCache,
  returningOneToOneConvexHops,
  returningOneToOneConvexRtts,
  returningTelegramConvexRtts,
} from "../agent/lib/inbound-path.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const convex = readFileSync(new URL("../agent/lib/convex.ts", import.meta.url), "utf8");
assert(convex.includes("loadWakeContext"), "memo+jobs share one snapshot");
assert(convex.includes("api.memories.wakeContext"), "one Convex query for wake context");
assert(convex.includes("wakeInflight"), "parallel turn.started callers coalesce");
assert(convex.includes("wakeCache"), "sequential memo then jobs reuse the snapshot");
assert(convex.includes("WAKE_CONTEXT_TTL_MS"), "wake snapshot is same-turn only");
assert(convex.includes("WAKE_CONTEXT_TTL_MS = 8_000"), "wake TTL outlasts Instinct searches");
assert(convex.includes("if (tenant) rememberHandleTenant"), "handle cache skips null");
assert(convex.includes("if (tenant) rememberTelegramTenant"), "telegram cache skips null");
assert(convex.includes("opts?.fresh"), "mail can bypass the handle cache");
assert(convex.includes("forgetWake"), "job writes drop the wake snapshot");
assert(convex.includes("cachedClient"), "Convex HTTP client is reused");
assert(convex.includes("forgetHandleTenant"), "bind/upsert drop the handle cache");
assert(convex.includes("forgetTelegramTenant"), "telegram bind drops its cache");
assert(convex.includes("handleTenants"), "returning 1:1 reuses getTenantByHandle");
assert(convex.includes("telegramTenants"), "returning telegram reuses getByTelegram");
assert(convex.includes("handleInflight"), "parallel handle lookups coalesce");

const memo = readFileSync(new URL("../agent/lib/convex-memory.ts", import.meta.url), "utf8");
assert(memo.includes("wakeLines"), "memo still injects wake lines");

const jobs = readFileSync(new URL("../agent/instructions/jobs.ts", import.meta.url), "utf8");
assert(jobs.includes("jobWakeRows"), "jobs read the same snapshot");
assert(jobs.includes("isJobCheckWakeup"), "job_check nudge is not on the HTTP path");
assert(jobs.includes("Promise.all"), "due markNudged calls run in parallel");
assert(jobs.includes("jobCheckQuietInstruction"), "non-due job_check may stay silent");

const archive = readFileSync(new URL("../agent/memory/archive.ts", import.meta.url), "utf8");
assert(archive.includes("shouldRecallArchive"), "archive recall is gated");
assert(archive.includes("ARCHIVE_RECALL_TIMEOUT_MS"), "archive recall is time-capped");

const recall = readFileSync(new URL("../agent/memory/recall.ts", import.meta.url), "utf8");
assert(recall.includes("shouldRecallConversation"), "conversation recall keeps captionless photos");
assert(recall.includes("compaction.completed"), "compaction recall uses the same gate");
assert(recall.includes("searchConversation"), "turn.started is one abortable search");
assert(recall.includes("CONVERSATION_RECALL_TIMEOUT_MS"), "conversation search is time-capped");
assert(!recall.includes("loadProfileContext"), "profile dump stays off turn.started");
assert(recall.includes("inner.recall"), "compaction still uses the plugin recall");
assert(recall.includes("abortSignal"), "conversation search joins Eve abort");

const tenants = readFileSync(new URL("../convex/tenants.ts", import.meta.url), "utf8");
{
  const countFn = tenants.slice(tenants.indexOf("export const countInboundMessage"));
  assert(countFn.includes('tenant.status === "disabled"'), "countInbound drops disabled");
  assert(
    countFn.indexOf('tenant.status === "disabled"') < countFn.indexOf("rateLimiter.limit"),
    "disabled drop before the daily increment",
  );
}

const memories = readFileSync(new URL("../convex/memories.ts", import.meta.url), "utf8");
assert(memories.includes("wakeContext"), "Convex exposes the combined snapshot");
assert(memories.includes("WAKE_LINES"), "combined snapshot still returns 80 memo lines");
assert(memories.includes("Promise.all"), "wakeContext loads memories and tenant in parallel");

const imessage = readFileSync(new URL("../agent/channels/imessage.ts", import.meta.url), "utf8");
assert(imessage.includes("canSkipInboundBind"), "returning users skip no-op bind");
assert(imessage.includes("prefetchInboundImages"), "photos download during bind/count");
assert(imessage.includes("voiceP"), "voice STT overlaps bind/count");
assert(imessage.includes("flaggedGroup"), "flagged groups skip the extra Convex lookup");
assert(imessage.includes("boundOneToOne"), "bound 1:1 skips getGroupByConversation");
assert(imessage.includes("imageUrlParts"), "photos do not tail-wait after bind");
assert(imessage.includes("getTenantByHandle"), "HMAC still loads the handle tenant");
assert(imessage.includes("loadWakeContext"), "1:1 billing prefetches wake context");
assert(imessage.includes("ackIMessageReadAndTyping"), "read+typing is one helper");
{
  const gatePAt = imessage.indexOf("const gateP = inboundOwnerGate");
  const awaitGateAt = imessage.indexOf("const gate = await gateP");
  const ackAt = imessage.indexOf("ackIMessageReadAndTyping", gatePAt);
  const wakeAt = imessage.indexOf("loadWakeContext(ownerPhone)", gatePAt);
  assert(gatePAt > 0 && awaitGateAt > gatePAt, "1:1 billing starts before it is awaited");
  assert(ackAt > gatePAt && ackAt < awaitGateAt, "bound 1:1 typing overlaps billing");
  assert(wakeAt > gatePAt && wakeAt < awaitGateAt, "wake prefetch overlaps billing");
}

const inkbox = readFileSync(new URL("../agent/lib/inkbox.ts", import.meta.url), "utf8");
assert(inkbox.includes("inkboxIdentity"), "Inkbox identity is cached");

const telegram = readFileSync(new URL("../agent/channels/telegram.ts", import.meta.url), "utf8");
assert(telegram.includes("inboundP"), "telegram STT overlaps photo fetch");
assert(telegram.includes("photoP"), "telegram photo overlaps billing");
assert(
  telegram.indexOf("const inbound = await inboundP") <
    telegram.indexOf("countInboundMessage(phone)"),
  "telegram bills only after a real inbound",
);
{
  const afterReal = telegram.indexOf("if (!inbound.text && !largestPhoto");
  const typingAt = telegram.indexOf("sendTelegramTyping", afterReal);
  const billAt = telegram.indexOf("countInboundMessage(phone)", afterReal);
  const wakeAt = telegram.indexOf("loadWakeContext(phone)", afterReal);
  assert(afterReal > 0 && typingAt > afterReal && typingAt < billAt, "telegram typing overlaps billing");
  assert(wakeAt > afterReal && wakeAt < billAt, "telegram wake prefetch overlaps billing");
}

const mail = readFileSync(new URL("../agent/lib/mail-inbound.ts", import.meta.url), "utf8");
assert(mail.includes("fresh: true"), "mail handle lookup is live for disabled/HMAC");

assert(HANDLE_TENANT_TTL_MS === 30_000, "handle tenant cache is short-lived");
assert(TELEGRAM_TENANT_TTL_MS === 30_000, "telegram tenant cache is short-lived");
const cache = createTtlCache<string>(50);
cache.set("h", "t", 1000);
assert(cache.get("h", 1049).hit === true, "ttl cache hits inside window");
assert(cache.get("h", 1050).hit === false, "ttl cache expires at ttl");
cache.set("h", "t", 2000);
cache.forget("h");
assert(cache.get("h", 2001).hit === false, "forget drops a live entry");
assert(
  returningOneToOneConvexRtts({
    handleCached: true,
    skipGroupLookup: true,
    skipBind: true,
  }) === 1,
  "warm returning 1:1 is billing only",
);
assert(
  returningOneToOneConvexHops({
    handleCached: true,
    skipGroupLookup: true,
    skipBind: true,
  }).join(",") === "countInboundMessage",
  "warm hops are countInbound only",
);
assert(
  returningOneToOneConvexRtts({
    handleCached: false,
    skipGroupLookup: true,
    skipBind: true,
  }) === 2,
  "bound but uncached handle still pays HMAC lookup",
);
assert(
  returningOneToOneConvexRtts({
    handleCached: false,
    skipGroupLookup: false,
    skipBind: false,
  }) === 4,
  "cold first-bind 1:1 still has four hops",
);
assert(returningTelegramConvexRtts({ telegramCached: true }) === 1, "warm telegram is billing only");
assert(returningTelegramConvexRtts({ telegramCached: false }) === 2, "cold telegram pays lookup");

assert(canSkipInboundBind({ phoneE164: "+1", inkboxConversationId: "c1" }, "+1", "c1"), "bound skip");
assert(
  !canSkipInboundBind({ phoneE164: "+1", inkboxConversationId: "c1" }, "+1", "c2"),
  "conversation change still binds",
);
assert(!canSkipInboundBind({ phoneE164: "+1" }, "+2", "c1"), "other phone still binds");
assert(!canSkipInboundBind({ phoneE164: "+1", status: "disabled" }, "+1", "c1"), "disabled still binds");
assert(CONVERSATION_RECALL_TIMEOUT_MS === 1500, "conversation recall matches archive budget");
assert((await withRecallBudget(Promise.resolve("ok"), 50)) === "ok", "budget keeps a fast recall");
assert((await withRecallBudget(new Promise<string>(() => {}), 15)) === null, "budget drops a late recall");

console.log("start-path-check ok");
console.log(
  JSON.stringify({
    turnStartedConvexRtts: 1,
    returningOneToOneConvexRttsWarm: 1,
    archiveRecallTimeoutMs: 1500,
    conversationRecallTimeoutMs: CONVERSATION_RECALL_TIMEOUT_MS,
    conversationRecallGated: true,
    jobCheckHttpListsJobs: false,
    inboundBindSkippedWhenBound: true,
    conversationRecallSearchOnly: true,
    handleTenantCached: true,
    boundTypingOverlapsBilling: true,
    telegramTypingOverlapsBilling: true,
    wakePrefetchDuringBilling: true,
    wakeContextTtlMs: 8000,
  }),
);