import {
  ARCHIVE_HIT_CHARS,
  ARCHIVE_TOOL_TIMEOUT_MS,
  archiveHitsFromSearch,
  archiveTag,
  type ArchiveDocument,
  type ArchiveHit,
} from "./archive-policy.ts";

const V3_BASE = "https://api.supermemory.ai/v3";
const V4_SEARCH = "https://api.supermemory.ai/v4/search";

function apiKey(): string {
  const key = process.env.SUPERMEMORY_API_KEY;
  if (!key?.trim()) throw new Error("SUPERMEMORY_API_KEY missing");
  return key.trim();
}

async function call(
  path: string,
  init: RequestInit,
  timeoutMs = ARCHIVE_TOOL_TIMEOUT_MS,
  abort?: AbortSignal,
): Promise<unknown> {
  const signal = abort
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), abort])
    : AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${V3_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`supermemory ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : await res.json();
}

/** Upsert one source document into the person's archive container. */
export async function ingestArchiveDocument(
  phone: string,
  doc: ArchiveDocument,
): Promise<void> {
  await call("/documents", {
    method: "POST",
    body: JSON.stringify({
      customId: doc.customId,
      title: doc.title,
      content: doc.content,
      containerTags: [archiveTag(phone)],
      metadata: { ...doc.metadata, phone },
    }),
  });
}

export async function searchArchive(
  phone: string,
  query: string,
  limit = 5,
  timeoutMs = ARCHIVE_TOOL_TIMEOUT_MS,
  abort?: AbortSignal,
): Promise<ArchiveHit[]> {
  const q = query.trim();
  if (!q) return [];
  const signal = abort
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), abort])
    : AbortSignal.timeout(timeoutMs);
  const res = await fetch(V4_SEARCH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({
      q,
      containerTag: archiveTag(phone),
      searchMode: "hybrid",
      include: { documents: true },
      rewriteQuery: false,
      rerank: false,
      limit,
    }),
  });
  if (!res.ok) {
    throw new Error(`supermemory /v4/search failed: ${res.status} ${await res.text()}`);
  }
  return archiveHitsFromSearch(await res.json(), ARCHIVE_HIT_CHARS);
}

type ListResponse = {
  memories?: { id?: string; metadata?: { app?: string } }[];
};

/**
 * Delete this person's archived copies — the whole archive, or one app.
 * This is the explicit "delete", separate from disconnecting the app.
 */
export async function forgetArchive(
  phone: string,
  app?: "gmail" | "calendar" | "inkbox",
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const json = (await call("/documents/list", {
      method: "POST",
      body: JSON.stringify({ containerTags: [archiveTag(phone)], limit: 100 }),
    })) as ListResponse;
    const targets = (json.memories ?? []).filter(
      (m) => m.id && (!app || m.metadata?.app === app),
    );
    if (targets.length === 0) return deleted;
    for (const m of targets) {
      await call(`/documents/${m.id}`, { method: "DELETE" });
      deleted++;
    }
    // A filtered pass can leave other-app documents on the page; stop after
    // one pass unless everything on it was deleted.
    if (targets.length < (json.memories ?? []).length) return deleted;
  }
}
