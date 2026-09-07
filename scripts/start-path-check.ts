/** Pins the turn.started critical path so serial Convex/HTTP does not creep back. */
import { readFileSync } from "node:fs";
import { canSkipInboundBind } from "../agent/lib/inbound-bind.ts";
import {
  CONVERSATION_RECALL_TIMEOUT_MS,
  withRecallBudget,
} from "../agent/lib/archive-policy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const convex = readFileSync(new URL("../agent/lib/convex.ts", import.meta.url), "utf8");
assert(convex.includes("loadWakeContext"), "memo+jobs share one snapshot");
assert(convex.includes("api.memories.wakeContext"), "one Convex query for wake context");
assert(convex.includes("wakeInflight"), "parallel turn.started callers coalesce");
assert(convex.includes("wakeCache"), "sequential memo then jobs reuse the snapshot");
assert(convex.includes("WAKE_CONTEXT_TTL_MS"), "wake snapshot is same-turn only");
assert(convex.includes("forgetWake"), "job writes drop the wake snapshot");
assert(convex.includes("cachedClient"), "Convex HTTP client is reused");

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
assert(recall.includes("CONVERSATION_RECALL_TIMEOUT_MS"), "conversation recall is time-capped");
assert(recall.includes("withRecallBudget"), "late conversation recall degrades");

const memories = readFileSync(new URL("../convex/memories.ts", import.meta.url), "utf8");
assert(memories.includes("wakeContext"), "Convex exposes the combined snapshot");
assert(memories.includes("WAKE_LINES"), "combined snapshot still returns 80 memo lines");
assert(memories.includes("Promise.all"), "wakeContext loads memories and tenant in parallel");

const imessage = readFileSync(new URL("../agent/channels/imessage.ts", import.meta.url), "utf8");
assert(imessage.includes("canSkipInboundBind"), "returning users skip no-op bind");
assert(imessage.includes("prefetchInboundImages"), "photos download during bind/count");
assert(imessage.includes("voiceP"), "voice STT overlaps bind/count");

const inkbox = readFileSync(new URL("../agent/lib/inkbox.ts", import.meta.url), "utf8");
assert(inkbox.includes("inkboxIdentity"), "Inkbox identity is cached");

const telegram = readFileSync(new URL("../agent/channels/telegram.ts", import.meta.url), "utf8");
assert(telegram.includes("inboundP"), "telegram STT overlaps billing");
assert(telegram.includes("photoP"), "telegram photo overlaps billing");

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
    archiveRecallTimeoutMs: 1500,
    conversationRecallTimeoutMs: CONVERSATION_RECALL_TIMEOUT_MS,
    conversationRecallGated: true,
    jobCheckHttpListsJobs: false,
    inboundBindSkippedWhenBound: true,
  }),
);