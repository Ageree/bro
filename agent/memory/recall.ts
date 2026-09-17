import supermemory from "@supermemory/eve";
import {
  defineMemory,
  type MemoryOperationContext,
  type MemoryRecallHandler,
  type MemoryRecallResult,
} from "eve/memory";
import {
  recallQuery,
  shouldRecallConversation,
} from "../lib/archive-policy.ts";
import { CONVERSATION_RECALL_ID } from "../lib/conversation-recall.ts";
import { loadInstinctRecall } from "../lib/instinct-recall.ts";
import {
  resolveSupermemoryScope,
  scopePhone,
  supermemoryKey,
} from "../lib/memory-policy.ts";

/**
 * Automatic conversation memory via Supermemory: completed turns are captured
 * per person, relevant context is recalled before each turn, and the model
 * gets recall__search / remember / forget. Since the Convex `memo` store went
 * away this is also where a durable fact goes — `recall__remember` is the one
 * write tool Bro has.
 *
 * SUPERMEMORY_API_KEY is required, not optional: `supermemoryKey()` throws
 * with a named variable rather than letting the slot disable itself.
 */
const inner = supermemory({ apiKey: () => supermemoryKey() });

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
    // Same arguments the archive slot passes, so whichever slot runs first
    // pays for the pass and the other one reads its result.
    const { conversation } = await loadInstinctRecall(
      scopePhone(context.memory.scope.value),
      query,
      context.abortSignal,
    );
    return conversation
      ? { messages: [{ id: CONVERSATION_RECALL_ID, content: conversation }] }
      : null;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return null;
    console.error("conversation recall failed", err);
    return null;
  }
}

export default defineMemory({
  namespace: "bro-recall-v1",
  description: "Automatic memory of past conversations with this person.",
  // Spelled out, not left to the compiler's default. `projectMemoryHistory`
  // (eve/dist/src/shared/memory-state.js) drops an already-injected recall
  // block on a scope change ONLY when the lock says `visibility === "scope"`;
  // with anything else a block injected under one person's scope stays in that
  // eve session's history after the slot re-locks to another. That is a
  // cross-conversation leak, and it is not a thing to leave to a default.
  visibility: "scope",
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
    resolveSupermemoryScope(ctx.session.auth),
});
