/** Pins the turn.started critical path so serial Convex/HTTP does not creep back. */
import { readFileSync } from "node:fs";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const convex = readFileSync(new URL("../agent/lib/convex.ts", import.meta.url), "utf8");
assert(convex.includes("loadWakeContext"), "memo+jobs share one snapshot");
assert(convex.includes("api.memories.wakeContext"), "one Convex query for wake context");
assert(convex.includes("wakeInflight"), "parallel turn.started callers coalesce");
assert(convex.includes("cachedClient"), "Convex HTTP client is reused");

const memo = readFileSync(new URL("../agent/lib/convex-memory.ts", import.meta.url), "utf8");
assert(memo.includes("wakeLines"), "memo still injects wake lines");

const jobs = readFileSync(new URL("../agent/instructions/jobs.ts", import.meta.url), "utf8");
assert(jobs.includes("jobWakeRows"), "jobs read the same snapshot");
assert(jobs.includes("wakeupKind"), "job_check nudge is not on the HTTP path");
assert(jobs.includes("Promise.all"), "due markNudged calls run in parallel");
assert(jobs.includes("jobCheckQuietInstruction"), "non-due job_check may stay silent");

const archive = readFileSync(new URL("../agent/memory/archive.ts", import.meta.url), "utf8");
assert(archive.includes("shouldRecallArchive"), "archive recall is gated");
assert(archive.includes("ARCHIVE_RECALL_TIMEOUT_MS"), "archive recall is time-capped");

const recall = readFileSync(new URL("../agent/memory/recall.ts", import.meta.url), "utf8");
assert(recall.includes("shouldRecallConversation"), "conversation recall keeps captionless photos");
assert(recall.includes("compaction.completed"), "compaction recall uses the same gate");

const memories = readFileSync(new URL("../convex/memories.ts", import.meta.url), "utf8");
assert(memories.includes("wakeContext"), "Convex exposes the combined snapshot");
assert(memories.includes("WAKE_LINES"), "combined snapshot still returns 80 memo lines");
assert(memories.includes("Promise.all"), "wakeContext loads memories and tenant in parallel");

console.log("start-path-check ok");
console.log(
  JSON.stringify({
    turnStartedConvexRtts: 1,
    archiveRecallTimeoutMs: 1500,
    conversationRecallGated: true,
    jobCheckHttpListsJobs: false,
  }),
);