/** Pins the turn.started critical path so serial Convex/HTTP does not creep back. */
import { readFileSync } from "node:fs";
import { canSkipInboundBind } from "../agent/lib/inbound-bind.ts";
import { CONVERSATION_RECALL_TIMEOUT_MS } from "../agent/lib/archive-policy.ts";
import {
  HANDLE_TENANT_TTL_MS,
  TELEGRAM_TENANT_TTL_MS,
  createTtlCache,
} from "../agent/lib/inbound-path.ts";
import {
  INSTINCT_RECALL_TTL_MS,
  canPrefetchInstinctQuery,
} from "../agent/lib/instinct-recall.ts";
import {
  canPrefetchOpenRouter,
  OPENROUTER_WARM_TIMEOUT_MS,
} from "../agent/lib/openrouter-warm.ts";
import {
  isShortAck,
  isShortAckTurn,
  shortAckAttribute,
  shortAckInstruction,
} from "../agent/lib/short-ack.ts";

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
assert(jobs.includes("JOB_CHECK_QUIET"), "non-due job_check may stay silent");
assert(jobs.includes("isShortAckTurn"), "short acks get a no-new-tools steer");
assert(jobs.includes("shortAckInstruction"), "short-ack instruction stays on turn.started");
assert(jobs.includes("waitingForHuman"), "ack that confirms a waiting job still allows tools");
assert(
  !jobs.includes("recallQuery(ctx.messages)"),
  "ack steer does not key off Eve history — that omits this turn",
);
assert(
  !jobs.includes("isShortAck(latest)"),
  "ack steer uses the stamped inbound flag, not the last history line",
);
assert(
  !jobs.includes('role: "user"'),
  "job/ack inject must not append to session history",
);

const archive = readFileSync(new URL("../agent/memory/archive.ts", import.meta.url), "utf8");
assert(archive.includes("shouldRecallArchive"), "archive recall is gated");
assert(archive.includes("loadInstinctRecall"), "archive recall shares the Instinct pair");
const archiveClient = readFileSync(new URL("../agent/lib/archive.ts", import.meta.url), "utf8");
assert(archiveClient.includes("/v4/search"), "Instinct archive search is v4, not v3 documents search");
assert(archiveClient.includes('searchMode: "hybrid"'), "archive search stays hybrid");
assert(archiveClient.includes("V3_BASE"), "ingest/forget stay on v3");

const recall = readFileSync(new URL("../agent/memory/recall.ts", import.meta.url), "utf8");
assert(recall.includes("shouldRecallConversation"), "conversation recall keeps captionless photos");
assert(recall.includes("compaction.completed"), "compaction recall uses the same gate");
assert(recall.includes("loadInstinctRecall"), "turn.started conversation uses the Instinct pair");
assert(recall.includes("conversationScope: context.memory.scope.key"), "conversation hook uses Eve digest");
assert(recall.includes("archiveScope: scopePhone"), "conversation hook still pairs archive by phone");
assert(!recall.includes("loadProfileContext"), "profile dump stays off turn.started");
assert(recall.includes("inner.recall"), "compaction still uses the plugin recall");
assert(recall.includes("abortSignal"), "conversation search joins Eve abort");

const instinct = readFileSync(new URL("../agent/lib/instinct-recall.ts", import.meta.url), "utf8");
assert(instinct.includes("Promise.allSettled"), "conversation and archive search in parallel");
assert(instinct.includes("searchConversation"), "conversation search stays on the pair");
assert(instinct.includes("searchArchive"), "archive search stays on the pair");
assert(instinct.includes("INSTINCT_RECALL_TTL_MS"), "Instinct pair is same-turn cached");
assert(instinct.includes("instinctInflight"), "parallel hooks coalesce one pair");
assert(instinct.includes("conversationScope"), "pair is keyed by Eve conversation scope");
assert(instinct.includes("instinctScopesForPerson"), "prefetch uses Eve digest + phone");
assert(
  instinct.includes('conversation.status === "fulfilled"') &&
    instinct.includes('archive.status === "fulfilled"'),
  "failed Instinct searches are not cached",
);
assert(instinct.includes("canPrefetchInstinctQuery"), "voice placeholders skip early prefetch");

const openrouterWarm = readFileSync(
  new URL("../agent/lib/openrouter-warm.ts", import.meta.url),
  "utf8",
);
const chatExtras = readFileSync(
  new URL("../agent/lib/openrouter-chat.ts", import.meta.url),
  "utf8",
);
assert(chatExtras.includes('effort = OPENROUTER_CHAT_REASONING_EFFORT'), "chat fills reasoning.effort");
assert(chatExtras.includes("OPENROUTER_CHAT_PROVIDER_SORT"), "chat fills provider.sort");
const modelLib = readFileSync(new URL("../agent/lib/model.ts", import.meta.url), "utf8");
assert(modelLib.includes("openRouterChatFetch"), "default GLM uses OpenRouter chat extras");

assert(openrouterWarm.includes("OPENROUTER_AUTH_URL"), "OpenRouter warm hits /auth/key");
assert(openrouterWarm.includes("OPENROUTER_CHAT_URL"), "OpenRouter warm also hits chat/completions");
assert(openrouterWarm.includes("max_tokens: 1"), "chat warm is a 1-token throwaway");
assert(openrouterWarm.includes("AbortSignal.timeout"), "OpenRouter warm is time-bounded");
assert(OPENROUTER_WARM_TIMEOUT_MS === 2_000, "chat warm stays 2s — do not block billing");
assert(openrouterWarm.includes("instructions.md"), "chat warm prefixes the static system prompt");
assert(openrouterWarm.includes('role: "system"'), "chat warm is production-shaped, not a bare user dot");
assert(
  !/from\s+['"]\.\/model(\.ts)?['"]/.test(openrouterWarm),
  "chat warm must not import model.ts — that is a cycle",
);
assert(
  !openrouterWarm.includes("tools:") && !openrouterWarm.includes("tool_choice"),
  "chat warm is tools-off — a tools-on warm would contend with the real turn",
);
assert(isShortAck("ок"), "ок is a short ack");
assert(isShortAck("Спасибо!"), "thanks with punct is a short ack");
assert(isShortAck("понял"), "понял is a short ack");
assert(!isShortAck("купи кроссовки"), "errands are not short acks");
assert(!isShortAck("да"), "bare да is not a short ack — it can be a real answer");
assert(
  shortAckInstruction({ waitingForHuman: true }).includes("confirmation"),
  "ack confirms a waiting job",
);
assert(
  shortAckInstruction({ waitingForHuman: false }).includes("browser_task"),
  "idle ack forbids a new browser loop",
);
assert(
  shortAckInstruction({ waitingForHuman: false }).includes("punctuation"),
  "idle ack asks for a punctuated first line so iMessage can flush",
);
assert(
  shortAckAttribute("ок").shortAck === "1",
  "channel stamps shortAck on this inbound ок",
);
assert(
  Object.keys(shortAckAttribute("купи кроссовки")).length === 0,
  "errands do not stamp shortAck",
);
assert(
  isShortAckTurn({ origin: "human", shortAck: "1" }),
  "stamped human ack is a short-ack turn",
);
assert(
  !isShortAckTurn({ origin: "human" }),
  "human errand without the stamp is not a short-ack turn",
);
assert(
  !isShortAckTurn({ origin: "wakeup", shortAck: "1" }),
  "wakeups never inherit a short-ack steer",
);
assert(
  !isShortAckTurn({ origin: "human", leftover: "ок" }),
  "leftover history text without the stamp is not a short-ack turn",
);
assert(canPrefetchOpenRouter("sk-test"), "OpenRouter warm runs when a key is set");
assert(!canPrefetchOpenRouter(""), "OpenRouter warm skips without a key");

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
assert(memories.includes("formatJobWakeLine"), "job lines are formatted, not dumped as JSON");
assert(
  !memories.includes("waitingSince=${"),
  "wake line omits epochs — nudge still uses structured waitingSince",
);

const imessage = readFileSync(new URL("../agent/channels/imessage.ts", import.meta.url), "utf8");
const earlyDeliver = readFileSync(
  new URL("../agent/lib/early-deliver.ts", import.meta.url),
  "utf8",
);
assert(imessage.includes("canSkipInboundBind"), "returning users skip no-op bind");
assert(imessage.includes("prefetchInboundImages"), "photos download during bind/count");
assert(imessage.includes("voiceP"), "voice STT overlaps bind/count");
assert(imessage.includes("flaggedGroup"), "flagged groups skip the extra Convex lookup");
assert(imessage.includes("boundOneToOne"), "bound 1:1 skips getGroupByConversation");
assert(imessage.includes("imageUrlParts"), "photos do not tail-wait after bind");
assert(imessage.includes("getTenantByHandle"), "HMAC still loads the handle tenant");
assert(imessage.includes("loadWakeContext"), "1:1 billing prefetches wake context");
assert(imessage.includes("prefetchInstinctRecall"), "1:1 billing prefetches Instinct searches");
assert(imessage.includes("shortAckAttribute(inbound.text)"), "1:1 inbound stamps this-turn ack");
assert(imessage.includes("prefetchOpenRouter"), "1:1 billing warms OpenRouter");
assert(
  imessage.includes("instinct voice prefetch failed"),
  "STT completion prefetches Instinct without waiting for billing",
);
assert(
  imessage.includes("prefetchInstinctRecall(ownerPhone, inbound.text)"),
  "final inbound text warms Instinct after STT",
);
assert(imessage.includes("ackIMessageReadAndTyping"), "read+typing is one helper");
assert(imessage.includes("planStreamFlush"), "first bubble can leave on a streamed newline");
assert(
  earlyDeliver.includes("likelyCompleteVisibleText"),
  "stream flush also sends a sentence/emoji-complete open line",
);
assert(imessage.includes("planPreToolFlush"), "first bubble can leave when a tool starts");
assert(
  imessage.includes("recordSent"),
  "delivered bubbles record the turn so tools can skip a second ищу",
);
{
  const ackFn = imessage.slice(imessage.indexOf("function ackIMessageReadAndTyping"));
  assert(ackFn.includes("Promise.all"), "read and typing share one identity GET");
}
{
  const gatePAt = imessage.indexOf("const gateP = inboundOwnerGate");
  const awaitGateAt = imessage.indexOf("const gate = await gateP");
  const ackAt = imessage.indexOf("ackIMessageReadAndTyping", gatePAt);
  const wakeAt = imessage.indexOf("loadWakeContext(ownerPhone)", gatePAt);
  const instinctAt = imessage.indexOf("prefetchInstinctRecall(ownerPhone", gatePAt);
  const orAt = imessage.indexOf("prefetchOpenRouter", gatePAt);
  assert(gatePAt > 0 && awaitGateAt > gatePAt, "1:1 billing starts before it is awaited");
  assert(ackAt > gatePAt && ackAt < awaitGateAt, "bound 1:1 typing overlaps billing");
  assert(wakeAt > gatePAt && wakeAt < awaitGateAt, "wake prefetch overlaps billing");
  assert(instinctAt > gatePAt && instinctAt < awaitGateAt, "Instinct prefetch overlaps billing");
  assert(orAt > gatePAt && orAt < awaitGateAt, "OpenRouter warm overlaps billing");
}

const inkbox = readFileSync(new URL("../agent/lib/inkbox.ts", import.meta.url), "utf8");
assert(inkbox.includes("inkboxIdentity"), "Inkbox identity is cached");

const telegram = readFileSync(new URL("../agent/channels/telegram.ts", import.meta.url), "utf8");
assert(telegram.includes("prefetchOpenRouter"), "telegram billing warms OpenRouter");
assert(telegram.includes("shortAckAttribute(opts.text"), "telegram stamps this-turn ack");
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
  const instinctAt = telegram.indexOf("prefetchInstinctRecall(phone", afterReal);
  assert(afterReal > 0 && typingAt > afterReal && typingAt < billAt, "telegram typing overlaps billing");
  assert(wakeAt > afterReal && wakeAt < billAt, "telegram wake prefetch overlaps billing");
  assert(instinctAt > afterReal && instinctAt < billAt, "telegram Instinct prefetch overlaps billing");
  const orAt = telegram.indexOf("prefetchOpenRouter", afterReal);
  assert(orAt > afterReal && orAt < billAt, "telegram OpenRouter warm overlaps billing");
}

const mail = readFileSync(new URL("../agent/lib/mail-inbound.ts", import.meta.url), "utf8");
assert(mail.includes("fresh: true"), "mail handle lookup is live for disabled/HMAC");

assert(INSTINCT_RECALL_TTL_MS === 8_000, "Instinct pair outlasts Eve session start");
assert(canPrefetchInstinctQuery("ок"), "human text still prefetches");
assert(
  !canPrefetchInstinctQuery("[voice message] https://cdn.example/a"),
  "voice URL placeholders do not prefetch",
);
assert(HANDLE_TENANT_TTL_MS === 30_000, "handle tenant cache is short-lived");
assert(TELEGRAM_TENANT_TTL_MS === 30_000, "telegram tenant cache is short-lived");
const cache = createTtlCache<string>(50);
cache.set("h", "t", 1000);
assert(cache.get("h", 1049).hit === true, "ttl cache hits inside window");
assert(cache.get("h", 1050).hit === false, "ttl cache expires at ttl");
cache.set("h", "t", 2000);
cache.forget("h");
assert(cache.get("h", 2001).hit === false, "forget drops a live entry");
const skipGroupAt = imessage.indexOf("!boundOneToOne && msg.conversation_id");
assert(skipGroupAt > 0 && skipGroupAt < imessage.indexOf("getGroupByConversation", skipGroupAt), "bound 1:1 skips group lookup");
assert(imessage.indexOf("if (boundOneToOne)") < imessage.indexOf("bindInbound("), "bound 1:1 skips bindInbound");

assert(canSkipInboundBind({ phoneE164: "+1", inkboxConversationId: "c1" }, "+1", "c1"), "bound skip");
assert(
  !canSkipInboundBind({ phoneE164: "+1", inkboxConversationId: "c1" }, "+1", "c2"),
  "conversation change still binds",
);
assert(!canSkipInboundBind({ phoneE164: "+1" }, "+2", "c1"), "other phone still binds");
assert(!canSkipInboundBind({ phoneE164: "+1", status: "disabled" }, "+1", "c1"), "disabled still binds");
assert(CONVERSATION_RECALL_TIMEOUT_MS === 1500, "conversation recall matches archive budget");

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
    instinctPrefetchDuringBilling: true,
    instinctRecallsParallel: true,
    openRouterWarmDuringBilling: true,
  }),
);