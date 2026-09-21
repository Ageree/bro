import { afterEach, describe, expect, it, vi } from "vitest";

const hydrateIndexedMemory = vi.fn<
  () => Promise<{
    content: {
      aliases: string[];
      category: "preference";
      localOnly: boolean;
      relatedIndexes: number[];
      text: string;
      validUntil: null;
    };
    index: number;
    revision: number;
    updatedAt: string;
  }>
>(async () => ({
  content: {
    aliases: [],
    category: "preference" as const,
    localOnly: false,
    relatedIndexes: [],
    text: "Local canonical text",
    validUntil: null,
  },
  index: 3,
  revision: 2,
  updatedAt: "2026-09-21T00:00:00.000Z",
}));

vi.mock("@shared/environment", () => ({
  env: { SUPERMEMORY_API_KEY: "test-supermemory-key" },
}));
vi.mock("@db/services/memory/sync", () => ({ hydrateIndexedMemory }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Supermemory semantic index", () => {
  it("writes a scoped immutable document without retries", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return Response.json({ id: "provider-doc", status: "queued" });
      })
    );
    const { addIndexedMemory, memoryContainerTag } =
      await import("@agent/lib/memory/supermemory");
    const response = await addIndexedMemory({
      aliases: ["coffee"],
      category: "preference",
      content: "Canonical memory",
      customId: "bro-memory-abc",
      generation: 1,
      recordIndex: 3,
      revision: 2,
      scopeKey: "scope-key",
      workspaceId: "workspace",
    });
    expect(response.id).toBe("provider-doc");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe("POST");
    if (!request) throw new Error("Expected an add request.");
    expect(new URL(request.url).pathname).toBe("/v3/documents");
    const body: unknown = await request.clone().json();
    expect(body).toMatchObject({
      containerTag: memoryContainerTag("workspace", "scope-key"),
      content: "Canonical memory\nAliases: coffee",
      customId: "bro-memory-abc",
      metadata: {
        category: "preference",
        generation: 1,
        recordIndex: 3,
        revision: 2,
        sourceKind: "profile",
      },
      taskType: "superrag",
    });
  });

  it("hydrates search hits locally and never returns provider prose", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return Response.json({
          results: [
            {
              chunks: [
                {
                  content: "UNTRUSTED PROVIDER TEXT",
                  isRelevant: true,
                  score: 0.9,
                },
              ],
              createdAt: "2026-09-20T00:00:00.000Z",
              documentId: "document-id",
              metadata: {
                generation: "1",
                recordIndex: "3",
                revision: "2",
                sourceKind: "profile",
              },
              score: 0.9,
              title: null,
              type: "text",
              updatedAt: "2026-09-21T00:00:00.000Z",
            },
          ],
          timing: 10,
          total: 1,
        });
      })
    );
    const { searchIndexedMemories } =
      await import("@agent/lib/memory/supermemory");
    const results = await searchIndexedMemories(
      { userId: "user", workspaceId: "workspace" },
      "scope-key",
      "morning coffee",
      new AbortController().signal
    );
    expect(results).not.toBeNull();
    if (!results) return;
    expect(results[0]?.content.text).toBe("Local canonical text");
    expect(JSON.stringify(results)).not.toContain("UNTRUSTED PROVIDER TEXT");
    expect(hydrateIndexedMemory).toHaveBeenCalledWith(
      { userId: "user", workspaceId: "workspace" },
      "scope-key",
      { generation: 1, recordIndex: 3, revision: 2 }
    );
    const [request] = requests;
    if (!request) throw new Error("Expected a search request.");
    const body: unknown = await request.clone().json();
    expect(new URL(request.url).pathname).toBe("/v3/search");
    expect(body).toMatchObject({
      includeFullDocs: false,
      includeSummary: false,
      onlyMatchingChunks: true,
      q: "morning coffee",
    });
  });

  it("uses permanent document deletion", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return new Response(null, { status: 204 });
      })
    );
    const { deleteIndexedMemory } =
      await import("@agent/lib/memory/supermemory");
    await deleteIndexedMemory("bro-memory-delete-me");
    const [request] = requests;
    expect(request?.method).toBe("DELETE");
    if (!request) throw new Error("Expected a delete request.");
    expect(new URL(request.url).pathname).toBe(
      "/v3/documents/bro-memory-delete-me"
    );
  });
});
