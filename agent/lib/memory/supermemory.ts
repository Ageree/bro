import { createHash } from "node:crypto";
import Supermemory, { APIError, NotFoundError } from "supermemory";
import type { SearchDocumentsResponse } from "supermemory/resources/search";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import { hydrateIndexedMemory } from "@db/services/memory/sync";

const foregroundTimeoutMs = 1_000;
const backgroundTimeoutMs = 15_000;

export function supermemoryConfigured() {
  return env.SUPERMEMORY_API_KEY !== undefined;
}

export function memoryContainerTag(workspaceId: string, scopeKey: string) {
  return `bro-${createHash("sha256")
    .update(`${workspaceId}:${scopeKey}`)
    .digest("hex")}`;
}

export async function addIndexedMemory(input: {
  aliases: string[];
  category: string;
  content: string;
  customId: string;
  generation: number;
  recordIndex: number;
  revision: number;
  scopeKey: string;
  workspaceId: string;
}) {
  const client = clientOrThrow();
  return client.add(
    {
      containerTag: memoryContainerTag(input.workspaceId, input.scopeKey),
      content: [
        input.content,
        input.aliases.length > 0
          ? `Aliases: ${input.aliases.join(", ")}`
          : null,
      ]
        .filter((line) => line !== null)
        .join("\n"),
      customId: input.customId,
      metadata: {
        category: input.category,
        generation: input.generation,
        recordIndex: input.recordIndex,
        revision: input.revision,
        sourceKind: "profile",
      },
      taskType: "superrag",
    },
    { maxRetries: 0, timeout: backgroundTimeoutMs }
  );
}

export async function deleteIndexedMemory(idOrCustomId: string) {
  try {
    await clientOrThrow().documents.delete(idOrCustomId, {
      maxRetries: 0,
      timeout: backgroundTimeoutMs,
    });
  } catch (error) {
    if (error instanceof NotFoundError) return;
    throw error;
  }
}

export async function searchIndexedMemories(
  scope: AccessScope,
  scopeKey: string,
  query: string,
  abortSignal: AbortSignal
) {
  if (!supermemoryConfigured() || query.trim().length === 0) return null;
  try {
    // oxlint-disable-next-line typescript/no-deprecated -- v3 document search is required because it returns canonical document metadata for hydration.
    const response = await clientOrThrow().search.documents(
      {
        containerTag: memoryContainerTag(scope.workspaceId, scopeKey),
        includeFullDocs: false,
        includeSummary: false,
        limit: 8,
        onlyMatchingChunks: true,
        q: query.slice(0, 500),
      },
      {
        maxRetries: 0,
        signal: abortSignal,
        timeout: foregroundTimeoutMs,
      }
    );
    const hydrated = await Promise.all(
      response.results.map(async (result) => {
        const metadata = parseMetadata(result.metadata);
        return metadata
          ? hydrateIndexedMemory(scope, scopeKey, metadata)
          : null;
      })
    );
    return hydrated.filter((record) => record !== null);
  } catch (error) {
    if (abortSignal.aborted) abortSignal.throwIfAborted();
    const providerError =
      error instanceof Error ? error : new Error("Unknown provider error");
    console.warn("[memory-index] semantic search unavailable", {
      errorCode: providerErrorCode(providerError),
    });
    return null;
  }
}

export function providerErrorCode(error: Error) {
  if (error instanceof APIError) {
    return error.status ? `http_${String(error.status)}` : error.name;
  }
  return error.name;
}

function clientOrThrow() {
  if (!env.SUPERMEMORY_API_KEY) {
    throw new Error("Supermemory is not configured.");
  }
  return new Supermemory({
    apiKey: env.SUPERMEMORY_API_KEY,
    logLevel: "off",
    maxRetries: 0,
    timeout: backgroundTimeoutMs,
  });
}

function parseMetadata(metadata: SearchDocumentsResponse.Result["metadata"]) {
  if (metadata?.sourceKind !== "profile") return null;
  const recordIndex = Number(metadata.recordIndex);
  const revision = Number(metadata.revision);
  const generation = Number(metadata.generation);
  if (
    !Number.isSafeInteger(recordIndex) ||
    !Number.isSafeInteger(revision) ||
    !Number.isSafeInteger(generation)
  )
    return null;
  return {
    generation,
    recordIndex,
    revision,
  };
}
