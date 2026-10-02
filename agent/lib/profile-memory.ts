import {
  defineMemoryProvider,
  type MemoryOperationContext,
  type MemoryProvider,
  type MemoryRecallHandler,
  type MemoryScopeContext,
} from "eve/memory";
import {
  MemoryDocumentConflictError,
  type MemoryDocumentBackend,
} from "eve/memory/file";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import {
  readMemoryDocument,
  writeMemoryDocument,
} from "@db/services/memory/documents";

/**
 * eve's file memory documents kept in Postgres (`memory_documents`), with
 * the row's version as the compare-and-set token eve's writes carry.
 */
export const postgresMemoryDocuments: MemoryDocumentBackend = {
  async read({ key }) {
    const row = await readMemoryDocument(key);
    return row ? { content: row.content, version: String(row.version) } : null;
  },
  async write({ content, expectedVersion, key }) {
    const expected = expectedVersion === null ? null : Number(expectedVersion);
    const version =
      expected === null || Number.isSafeInteger(expected)
        ? await writeMemoryDocument({
            content,
            expectedVersion: expected,
            scopeKey: key,
          })
        : undefined;
    if (version === undefined) throw new MemoryDocumentConflictError(key);
    return { content, version: String(version) };
  },
};

export function resolveProfileMemoryScope(context: MemoryScopeContext) {
  const caller = context.session.auth.current;
  const workspaceId = z.string().safeParse(caller?.attributes.workspaceId);
  const scope =
    caller?.principalType === "user" && workspaceId.success
      ? workspaceId.data
      : null;
  return resolveModeValue(context, {
    interactive: scope,
    "proactive-worker": scope,
    "scheduled-worker": scope,
  });
}

export function preserveProfileMemoryCancellation(provider: MemoryProvider) {
  const compactionRecall = provider.recall["compaction.completed"];
  return defineMemoryProvider({
    ...provider,
    recall: {
      "turn.started": (context) =>
        recallWithCancellationReason(provider.recall["turn.started"], context),
      "compaction.completed": (context) =>
        compactionRecall
          ? recallWithCancellationReason(compactionRecall, context)
          : undefined,
    },
  });
}

async function recallWithCancellationReason<
  Context extends MemoryOperationContext,
>(handler: MemoryRecallHandler<Context>, context: Context) {
  try {
    return await handler(context);
  } catch (error) {
    if (context.abortSignal.aborted) {
      context.abortSignal.throwIfAborted();
    }
    throw error;
  }
}
