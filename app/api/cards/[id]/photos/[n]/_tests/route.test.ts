import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { readCardByLink } from "@db/services/cards";
import { cardPhotoObject } from "@shared/cards/photos";
import { cardSchema } from "@shared/cards/schema";
import type { openArtifactObject } from "@shared/object-storage/artifacts";

const mocks = vi.hoisted(() => ({
  open: vi.fn<typeof openArtifactObject>(),
  read: vi.fn<typeof readCardByLink>(),
}));

vi.mock("@db/services/cards", () => ({ readCardByLink: mocks.read }));
vi.mock("@shared/object-storage/artifacts", () => ({
  artifactStorageConfigured: () => true,
  openArtifactObject: mocks.open,
}));

import { GET } from "@app/api/cards/[id]/photos/[n]/route";

const cardId = "K".repeat(43);
const otherId = "Z".repeat(43);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

function cardShowing(...paths: string[]) {
  return {
    card: cardSchema.parse({
      blocks: [
        {
          photos: paths.map((url) => ({ alt: "Кухня", url })),
          type: "gallery",
        },
      ],
      title: "Квартира",
    }),
    conversationChannel: "telegram" as const,
    conversationId: "4242::",
    createdAt: new Date("2026-10-23T10:00:00Z"),
    id: cardId,
    revision: 1,
    updatedAt: new Date("2026-10-23T10:00:00Z"),
    userId: "alice",
    workspaceId: "workspace:alice",
  };
}

function photo(id: string, n: string, headers: HeadersInit = {}) {
  return GET(
    new Request(`https://bro.example/api/cards/${id}/photos/${n}`, { headers }),
    { params: Promise.resolve({ id, n }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(
    cardShowing(
      `/api/cards/${cardId}/photos/0`,
      `/api/cards/${cardId}/photos/1`
    )
  );
  mocks.open.mockImplementation(() =>
    Promise.resolve({
      contentType: "image/webp",
      etag: '"photo"',
      size: webp.byteLength,
      status: 200 as const,
      stream: new Response(webp).body ?? new ReadableStream(),
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a card's photo", () => {
  it("is served by the card's link, privately, as the image it is", async () => {
    const response = await photo(cardId, "1");

    expect(response.status).toBe(200);
    expect(mocks.open).toHaveBeenCalledWith(
      cardPhotoObject(cardId, 1),
      expect.anything()
    );
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe(
      "private, max-age=86400"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox"
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(webp);
  });

  it("answers a copy the browser holds with 304", async () => {
    mocks.open.mockResolvedValueOnce({ etag: '"photo"', status: 304 });

    const response = await photo(cardId, "0", { "if-none-match": '"photo"' });

    expect(response.status).toBe(304);
    expect(mocks.open).toHaveBeenCalledWith(
      cardPhotoObject(cardId, 0),
      expect.objectContaining({ ifNoneMatch: '"photo"' })
    );
  });

  it("is a 404 for an expired or unknown card, and no read of the store", async () => {
    mocks.read.mockResolvedValueOnce(undefined);

    const response = await photo(cardId, "0");

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("is a 404 for a number the card does not show", async () => {
    for (const n of ["2", "01", "-1", "1000", "1.5", "photo"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one request at a time, each checked
      expect((await photo(cardId, n)).status).toBe(404);
    }
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("never serves another card's photo through this card's link", async () => {
    mocks.read.mockResolvedValueOnce(
      cardShowing(
        `/api/cards/${otherId}/photos/0`,
        `/api/cards/${otherId}/photos/1`
      )
    );

    const response = await photo(cardId, "0");

    expect(response.status).toBe(404);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("is a 404 for an object that is not one of a card's photo types", async () => {
    const cancel = vi.fn<() => Promise<void>>(() => Promise.resolve());
    mocks.open.mockResolvedValueOnce({
      contentType: "text/html",
      etag: '"page"',
      size: 4,
      status: 200,
      stream: Object.assign(new ReadableStream(), { cancel }),
    });

    expect((await photo(cardId, "0")).status).toBe(404);
    expect(cancel).toHaveBeenCalled();
  });

  it("says the store failed without logging the address", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.open.mockRejectedValueOnce(
      new Error(`Object Storage 500 on GET: <Key>${cardId}</Key>`)
    );

    const response = await photo(cardId, "0");

    expect(response.status).toBe(502);
    expect(JSON.stringify(error.mock.calls)).not.toContain(cardId);
  });
});
