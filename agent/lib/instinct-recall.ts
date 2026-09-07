/**
 * One in-flight Instinct pair (conversation + archive). Eve already
 * Promise.all's memory slots; this starts both HTTP searches together and
 * lets the webhook hide them behind billing + session start.
 */
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
import { createTtlCache } from "./inbound-path.ts";

export const INSTINCT_RECALL_TTL_MS = 8_000;
export const ARCHIVE_RECALL_HITS = 4;

export type InstinctRecall = {
  conversation: string | null;
  archive: string | null;
};

const instinctCache = createTtlCache<InstinctRecall>(INSTINCT_RECALL_TTL_MS);
const instinctInflight = new Map<string, Promise<InstinctRecall>>();

function instinctKey(scopeKey: string, query: string): string {
  return `${scopeKey}\n${query}`;
}

function recallText(query: string): string {
  return (
    recallQuery([{ role: "user", content: query }]) ?? query.trim().slice(0, 300)
  );
}

export function prefetchInstinctRecall(scopeKey: string, query: string): void {
  if (!process.env.SUPERMEMORY_API_KEY?.trim()) return;
  const q = recallText(query);
  if (!q || !shouldRecallArchive(q)) return;
  void loadInstinctRecall(scopeKey, q).catch((err) =>
    console.error("instinct prefetch failed", err),
  );
}

/** Parallel conversation + archive search. Same-turn cache keyed by scope+query. */
export async function loadInstinctRecall(
  scopeKey: string,
  query: string,
  abort?: AbortSignal,
): Promise<InstinctRecall> {
  const q = recallText(query);
  if (!q) return { conversation: null, archive: null };
  const key = instinctKey(scopeKey, q);
  const cached = instinctCache.get(key);
  if (cached.hit) return cached.value;
  const existing = instinctInflight.get(key);
  if (existing) return existing;
  const pending = Promise.all([
    searchConversation(scopeKey, q, CONVERSATION_RECALL_TIMEOUT_MS, abort)
      .then(formatConversationRecall)
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return null;
        console.error("conversation recall failed", err);
        return null;
      }),
    searchArchive(scopeKey, q, ARCHIVE_RECALL_HITS, ARCHIVE_RECALL_TIMEOUT_MS, abort)
      .then(formatArchiveRecall)
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return null;
        console.error("archive recall failed", err);
        return null;
      }),
  ])
    .then(([conversation, archive]) => {
      const value = { conversation, archive };
      instinctCache.set(key, value);
      return value;
    })
    .finally(() => {
      instinctInflight.delete(key);
    });
  instinctInflight.set(key, pending);
  return pending;
}
