import { searchArchive } from "./archive.ts";
import {
  ARCHIVE_RECALL_TIMEOUT_MS,
  CONVERSATION_RECALL_TIMEOUT_MS,
  formatArchiveRecall,
  recallQuery,
  shouldRecallArchive,
} from "./archive-policy.ts";
import {
  formatConversationRecall,
  searchConversation,
} from "./conversation-recall.ts";
import { conversationScopeKey } from "./eve-scope-key.ts";
import { createTtlCache } from "./inbound-path.ts";

export const INSTINCT_RECALL_TTL_MS = 8_000;
export const ARCHIVE_RECALL_HITS = 4;

export type InstinctScopes = {
  archiveScope: string;
  conversationScope: string;
};

export type InstinctRecall = {
  conversation: string | null;
  archive: string | null;
};

const instinctCache = createTtlCache<InstinctRecall>(INSTINCT_RECALL_TTL_MS);
const instinctInflight = new Map<string, Promise<InstinctRecall>>();

function instinctKey(scopes: InstinctScopes, query: string): string {
  return `${scopes.archiveScope}\n${scopes.conversationScope}\n${query}`;
}

function recallText(query: string): string {
  return (
    recallQuery([{ role: "user", content: query }]) ?? query.trim().slice(0, 300)
  );
}

export function instinctScopesForPerson(scopeValue: string): InstinctScopes {
  return {
    archiveScope: scopeValue,
    conversationScope: conversationScopeKey(scopeValue),
  };
}

export function canPrefetchInstinctQuery(query: string): boolean {
  const q = recallText(query);
  if (!q || !shouldRecallArchive(q)) return false;
  return !q.includes("[voice message]");
}

export function prefetchInstinctRecall(scopeValue: string, query: string): void {
  if (!process.env.SUPERMEMORY_API_KEY?.trim()) return;
  if (!canPrefetchInstinctQuery(query)) return;
  void loadInstinctRecall(instinctScopesForPerson(scopeValue), recallText(query)).catch(
    (err) => console.error("instinct prefetch failed", err),
  );
}

function settledHalf(
  result: PromiseSettledResult<string | null>,
  label: string,
): string | null {
  if (result.status === "fulfilled") return result.value;
  if (!(result.reason instanceof Error && result.reason.name === "AbortError")) {
    console.error(`${label} recall failed`, result.reason);
  }
  return null;
}

/**
 * One log line per recall attempt, with the measured latency and the budget it
 * ran under. Without this the only production signal was `… recall failed
 * TimeoutError`, which says a request was too slow but never how slow — so the
 * budget could only ever be guessed at. A hit logs its latency too, so the
 * margin between a typical hit and the budget is visible rather than inferred.
 */
function recallOutcome(
  label: string,
  result: PromiseSettledResult<string | null>,
  ms: number,
  budgetMs: number,
): void {
  const timedOut =
    result.status === "rejected" &&
    result.reason instanceof Error &&
    (result.reason.name === "TimeoutError" || result.reason.name === "AbortError");
  console.log(`recall ${label}`, {
    ms,
    budgetMs,
    outcome:
      result.status === "fulfilled"
        ? result.value
          ? "hit"
          : "empty"
        : timedOut
          ? "timeout"
          : "error",
  });
}

export async function loadInstinctRecall(
  scopes: InstinctScopes,
  query: string,
  abort?: AbortSignal,
): Promise<InstinctRecall> {
  const q = recallText(query);
  if (!q) return { conversation: null, archive: null };
  if (!scopes.archiveScope.trim() || !scopes.conversationScope.trim()) {
    throw new Error("Instinct scopes must be non-empty");
  }
  const key = instinctKey(scopes, q);
  const cached = instinctCache.get(key);
  if (cached.hit) return cached.value;
  const existing = instinctInflight.get(key);
  if (existing) return existing;
  const startedAt = Date.now();
  const pending = Promise.allSettled([
    searchConversation(
      scopes.conversationScope,
      q,
      CONVERSATION_RECALL_TIMEOUT_MS,
      abort,
    ).then(formatConversationRecall),
    searchArchive(
      scopes.archiveScope,
      q,
      ARCHIVE_RECALL_HITS,
      ARCHIVE_RECALL_TIMEOUT_MS,
      abort,
    ).then(formatArchiveRecall),
  ])
    .then(([conversation, archive]) => {
      const ms = Date.now() - startedAt;
      recallOutcome("conversation", conversation, ms, CONVERSATION_RECALL_TIMEOUT_MS);
      recallOutcome("archive", archive, ms, ARCHIVE_RECALL_TIMEOUT_MS);
      const value = {
        conversation: settledHalf(conversation, "conversation"),
        archive: settledHalf(archive, "archive"),
      };
      if (conversation.status === "fulfilled" && archive.status === "fulfilled") {
        instinctCache.set(key, value);
      }
      return value;
    })
    .finally(() => {
      instinctInflight.delete(key);
    });
  instinctInflight.set(key, pending);
  return pending;
}
