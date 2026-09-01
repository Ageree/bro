import {
  archiveTag,
  type ArchiveDocument,
  type ArchiveHit,
} from "./archive-policy.ts";

const BASE = "https://api.supermemory.ai/v3";
const HIT_CHARS = 600;

function apiKey(): string {
  const key = process.env.SUPERMEMORY_API_KEY;
  if (!key?.trim()) throw new Error("SUPERMEMORY_API_KEY missing");
  return key.trim();
}

async function call(path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
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

type SearchResponse = {
  results?: {
    title?: string;
    metadata?: { app?: string; date?: string };
    chunks?: { content?: string }[];
  }[];
};

/** Semantic search inside one person's archive. */
export async function searchArchive(
  phone: string,
  query: string,
  limit = 5,
): Promise<ArchiveHit[]> {
  const json = (await call("/search", {
    method: "POST",
    body: JSON.stringify({
      q: query,
      containerTags: [archiveTag(phone)],
      limit,
    }),
  })) as SearchResponse;
  return (json.results ?? []).map((r) => ({
    title: r.title ?? "",
    content: (r.chunks ?? [])
      .map((c) => c.content ?? "")
      .join("\n")
      .slice(0, HIT_CHARS),
    app: r.metadata?.app ?? "app",
    date: r.metadata?.date,
  }));
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
  app?: "gmail" | "calendar",
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
