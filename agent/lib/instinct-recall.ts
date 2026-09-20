import { searchArchive } from "./archive.ts";
import {
  ARCHIVE_RECALL_TIMEOUT_MS,
  CONVERSATION_RECALL_TIMEOUT_MS,
  formatArchiveRecall,
  recallQuery,
  shouldRecallArchive,
  shouldRecallConversation,
} from "./archive-policy.ts";
import {
  formatConversationRecall,
  searchConversation,
} from "./conversation-recall.ts";
import { conversationScopeKey } from "./eve-scope-key.ts";
import { createTtlCache } from "./inbound-path.ts";

export const INSTINCT_RECALL_TTL_MS = 8_000;
export const ARCHIVE_RECALL_HITS = 4;

export type InstinctRecall = {
  conversation: string | null;
  archive: string | null;
};

const EMPTY: InstinctRecall = { conversation: null, archive: null };

const instinctCache = createTtlCache<InstinctRecall>(INSTINCT_RECALL_TTL_MS);
const instinctInflight = new Map<string, Promise<InstinctRecall>>();

/**
 * ONE key per person and query — nothing else.
 *
 * It used to be `${archiveScope}\n${conversationScope}\n${query}`, with the
 * two callers deriving `conversationScope` differently: the recall slot passed
 * eve's own `scope.key`, the archive slot recomputed it from the phone, and
 * the webhook prefetch used the recomputed one. Three spellings of the same
 * person, so the cache and the in-flight map could not do their job and the
 * turn paid for the same two searches twice, all of it in front of the first
 * model token. The scope VALUE (the E.164) is the one thing every caller
 * already has, so it is the key; the eve container tag is derived inside.
 */
function instinctKey(scopeValue: string, query: string): string {
  return `${scopeValue}\n${query}`;
}

function recallText(query: string): string {
  return (
    recallQuery([{ role: "user", content: query }]) ?? query.trim().slice(0, 300)
  );
}

export function canPrefetchInstinctQuery(query: string): boolean {
  const q = recallText(query);
  if (!q) return false;
  if (!shouldRecallArchive(q) && !shouldRecallConversation(q)) return false;
  return !q.includes("[voice message]");
}

/**
 * Warm the one pass the turn is about to ask for. Same key as the slots use,
 * so this actually lands: while it was keyed on the mirrored scope it could
 * only ever warm the half whose caller happened to spell the scope the same
 * way, which is the half the recall slot was NOT asking for.
 */
export function prefetchInstinctRecall(scopeValue: string, query: string): void {
  if (!scopeValue.trim() || !canPrefetchInstinctQuery(query)) return;
  void loadInstinctRecall(scopeValue, recallText(query)).catch((err) =>
    console.error("instinct prefetch failed", err),
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

/**
 * Both recall halves for one person and one query, computed ONCE per turn.
 *
 * Two slots read this — `recall` keeps `.conversation`, `archive` keeps
 * `.archive` — and both call it with the same person and the same query, so
 * the second caller gets the first one's in-flight promise instead of firing
 * its own pair of Supermemory round trips.
 *
 * Which halves run is decided here, from the query alone, so the decision is a
 * pure function of the cache key and a cached entry can never be a different
 * shape than a fresh one. A skipped half is `null`, exactly like an empty one.
 */
export async function loadInstinctRecall(
  scopeValue: string,
  query: string,
  abort?: AbortSignal,
): Promise<InstinctRecall> {
  const q = recallText(query);
  if (!q) return EMPTY;
  if (!scopeValue.trim()) throw new Error("Instinct recall scope must be non-empty");
  const key = instinctKey(scopeValue, q);
  const cached = instinctCache.get(key);
  if (cached.hit) return cached.value;
  const existing = instinctInflight.get(key);
  if (existing) return existing;
  const wantConversation = shouldRecallConversation(q);
  const wantArchive = shouldRecallArchive(q);
  if (!wantConversation && !wantArchive) return EMPTY;
  const startedAt = Date.now();
  const pending = Promise.allSettled([
    wantConversation
      ? searchConversation(
          conversationScopeKey(scopeValue),
          q,
          CONVERSATION_RECALL_TIMEOUT_MS,
          abort,
        ).then(formatConversationRecall)
      : Promise.resolve(null),
    wantArchive
      ? searchArchive(
          scopeValue,
          q,
          ARCHIVE_RECALL_HITS,
          ARCHIVE_RECALL_TIMEOUT_MS,
          abort,
        ).then(formatArchiveRecall)
      : Promise.resolve(null),
  ])
    .then(([conversation, archive]) => {
      const ms = Date.now() - startedAt;
      if (wantConversation) {
        recallOutcome("conversation", conversation, ms, CONVERSATION_RECALL_TIMEOUT_MS);
      }
      if (wantArchive) recallOutcome("archive", archive, ms, ARCHIVE_RECALL_TIMEOUT_MS);
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
