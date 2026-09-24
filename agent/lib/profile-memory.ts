import {
  defineMemoryProvider,
  type MemoryOperationContext,
  type MemoryProvider,
  type MemoryRecallHandler,
  type MemoryScopeContext,
} from "eve/memory";
import { z } from "zod";
import type { env } from "@shared/environment";
import { resolveModeValue } from "@agent/lib/mode";

export function resolveProfileMemoryBackend(
  environment: Pick<
    typeof env,
    | "BLOB_READ_WRITE_TOKEN"
    | "BLOB_STORE_ID"
    | "EVE_MEMORY_BLOB_READ_WRITE_TOKEN"
    | "EVE_MEMORY_BLOB_STORE_ID"
    | "NODE_ENV"
    | "VERCEL_ENV"
  >
) {
  if (environment.NODE_ENV !== "production") {
    return { kind: "automatic" as const };
  }

  if (environment.BLOB_STORE_ID) {
    return {
      kind: "vercel-blob" as const,
      options: { storeId: environment.BLOB_STORE_ID },
    };
  }

  if (
    environment.VERCEL_ENV === undefined &&
    environment.BLOB_READ_WRITE_TOKEN
  ) {
    return {
      kind: "vercel-blob" as const,
      options: { token: environment.BLOB_READ_WRITE_TOKEN },
    };
  }
  if (environment.EVE_MEMORY_BLOB_STORE_ID) {
    return {
      kind: "vercel-blob" as const,
      options: { storeId: environment.EVE_MEMORY_BLOB_STORE_ID },
    };
  }
  const token =
    environment.EVE_MEMORY_BLOB_READ_WRITE_TOKEN ??
    environment.BLOB_READ_WRITE_TOKEN;
  return token
    ? { kind: "vercel-blob" as const, options: { token } }
    : { kind: "automatic" as const };
}

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
