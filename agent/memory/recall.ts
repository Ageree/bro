import supermemory from "@supermemory/eve";
import {
  defineMemory,
  type MemoryOperationContext,
  type MemoryRecallHandler,
} from "eve/memory";
import {
  CONVERSATION_RECALL_TIMEOUT_MS,
  recallQuery,
  shouldRecallConversation,
  withRecallBudget,
} from "../lib/archive-policy.ts";
import { resolveMemoryScope, resolveRecallBackend } from "../lib/memory-policy.ts";

/**
 * Automatic conversation memory via Supermemory (paid, zero-config for users):
 * completed turns are captured per person, relevant context is recalled before
 * each turn, and the model gets recall__search / remember / forget tools.
 *
 * Without SUPERMEMORY_API_KEY the scope resolves to null, which disables this
 * slot entirely; the curated `memo` slot keeps working on Convex alone.
 *
 * Auto-recall on `turn.started` uses the same wakeup gate as the archive
 * slot: human chat, mail events, brief, and job_check still search.
 * `browser_poll` / plain reminders skip the paid HTTP round-trip.
 * The hook itself is time-capped to `CONVERSATION_RECALL_TIMEOUT_MS` so
 * uncapped Supermemory HTTP cannot delay the first token past archive.
 * Tools stay mounted either way.
 */
const inner = supermemory({
  apiKey: () => {
    const backend = resolveRecallBackend(process.env);
    if (backend.kind !== "supermemory") {
      throw new Error("SUPERMEMORY_API_KEY missing");
    }
    return backend.apiKey;
  },
});

type RecallCtx = MemoryOperationContext & {
  turn?: { input?: readonly unknown[] } | null;
};

function gatedRecall<TContext extends RecallCtx>(
  hook: MemoryRecallHandler<TContext> | undefined,
): MemoryRecallHandler<TContext> {
  return (context) => {
    const query =
      recallQuery(context.turn?.input ?? []) ?? recallQuery(context.messages);
    if (!shouldRecallConversation(query)) return null;
    if (typeof hook !== "function") return null;
    return withRecallBudget(hook(context), CONVERSATION_RECALL_TIMEOUT_MS);
  };
}

export default defineMemory({
  namespace: "bro-recall-v1",
  description: "Automatic memory of past conversations with this person.",
  provider: {
    ...inner,
    recall: {
      ...inner.recall,
      "turn.started": gatedRecall(inner.recall?.["turn.started"]),
      "compaction.completed": gatedRecall(inner.recall?.["compaction.completed"]),
    },
  },
  scope: (ctx) =>
    resolveRecallBackend(process.env).kind === "supermemory"
      ? resolveMemoryScope(ctx.session.auth, process.env.NODE_ENV === "production")
      : null,
});
