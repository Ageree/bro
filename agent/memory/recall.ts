import supermemory from "@supermemory/eve";
import {
  defineMemory,
  type MemoryOperationContext,
  type MemoryRecallHandler,
  type MemoryRecallResult,
} from "eve/memory";
import {
  CONVERSATION_RECALL_TIMEOUT_MS,
  recallQuery,
  shouldRecallConversation,
} from "../lib/archive-policy.ts";
import {
  CONVERSATION_RECALL_ID,
  formatConversationRecall,
  searchConversation,
} from "../lib/conversation-recall.ts";
import { resolveMemoryScope, resolveRecallBackend } from "../lib/memory-policy.ts";

/**
 * Automatic conversation memory via Supermemory (paid, zero-config for users):
 * completed turns are captured per person, relevant context is recalled before
 * each turn, and the model gets recall__search / remember / forget tools.
 *
 * Without SUPERMEMORY_API_KEY the scope resolves to null, which disables this
 * slot entirely; the curated `memo` slot keeps working on Convex alone.
 *
 * `turn.started` is one abortable search (same 1.5s Instinct budget as archive),
 * not the plugin's profile + documents.list + memories/list dump.
 * Compaction still uses the full plugin recall. Tools stay mounted either way.
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

function gated<TContext extends RecallCtx>(
  hook: (context: TContext) => MemoryRecallResult | Promise<MemoryRecallResult>,
): MemoryRecallHandler<TContext> {
  return (context) => {
    const query =
      recallQuery(context.turn?.input ?? []) ?? recallQuery(context.messages);
    if (!shouldRecallConversation(query)) return null;
    return hook(context);
  };
}

async function startedSearch(context: RecallCtx): Promise<MemoryRecallResult> {
  const query =
    recallQuery(context.turn?.input ?? []) ?? recallQuery(context.messages);
  if (!query?.trim()) return null;
  try {
    const hits = await searchConversation(
      context.memory.scope.key,
      query,
      CONVERSATION_RECALL_TIMEOUT_MS,
      context.abortSignal,
    );
    const content = formatConversationRecall(hits);
    return content ? { messages: [{ id: CONVERSATION_RECALL_ID, content }] } : null;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return null;
    console.error("conversation recall failed", err);
    return null;
  }
}

export default defineMemory({
  namespace: "bro-recall-v1",
  description: "Automatic memory of past conversations with this person.",
  provider: {
    ...inner,
    recall: {
      ...inner.recall,
      "turn.started": gated(startedSearch),
      "compaction.completed": gated((ctx) => {
        const hook = inner.recall?.["compaction.completed"];
        return typeof hook === "function" ? hook(ctx as never) : null;
      }),
    },
  },
  scope: (ctx) =>
    resolveRecallBackend(process.env).kind === "supermemory"
      ? resolveMemoryScope(ctx.session.auth, process.env.NODE_ENV === "production")
      : null,
});
