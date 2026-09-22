import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import { accessScopeForUser } from "@shared/identity/access-scope";

const runId = "11111111-1111-4111-8111-111111111111";
const browserSessionId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const runCreatedAt = "2026-09-22T10:00:00.000Z";
const scope = accessScopeForUser("better-auth:alice");

interface WorkspaceFile {
  lastModified: string;
  path: string;
  size: number;
  url: string | null;
}

interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const listBrowserUseWorkspaceFiles = vi.hoisted(() =>
  vi.fn<
    (workspace: string, prefix: string) => Promise<{ files: WorkspaceFile[] }>
  >()
);
const findBrowserUseSessionCdpUrl = vi.hoisted(() =>
  vi.fn<(sessionId: string) => Promise<string | undefined>>()
);
const captureViewportOverCdp = vi.hoisted(() =>
  vi.fn<(cdpUrl: string) => Promise<Uint8Array>>()
);
const blobs = vi.hoisted(() => new Map<string, StoredBlob>());
const put = vi.hoisted(() =>
  vi.fn<
    (
      pathname: string,
      body: Buffer,
      options: { access: string; contentType: string }
    ) => Promise<{ pathname: string }>
  >((pathname, body, options) => {
    blobs.set(pathname, {
      bytes: new Uint8Array(body),
      contentType: options.contentType,
    });
    return Promise.resolve({ pathname });
  })
);

vi.mock("@agent/lib/browser-use/client", () => ({
  findBrowserUseSessionCdpUrl,
  listBrowserUseWorkspaceFiles,
}));
vi.mock("@agent/lib/browser-use/cdp", () => ({ captureViewportOverCdp }));
// A private Blob store held in memory: what `put` wrote is what `get` serves.
vi.mock("@vercel/blob", () => ({
  get: (pathname: string) => {
    const stored = blobs.get(pathname);
    if (!stored) return Promise.resolve(null);
    return Promise.resolve({
      blob: {
        contentType: stored.contentType,
        etag: '"etag"',
        size: stored.bytes.byteLength,
      },
      statusCode: 200,
      stream: new Response(Buffer.from(stored.bytes)).body,
    });
  },
  put,
}));

const databases: PGlite[] = [];
// A fresh response per request: cancelling a cloned body waits on its twin,
// which would hang the oversize case the downloader cancels.
const downloads = new Map<string, () => Response>();

beforeEach(() => {
  blobs.clear();
  downloads.clear();
  findBrowserUseSessionCdpUrl.mockResolvedValue(undefined);
  listBrowserUseWorkspaceFiles.mockResolvedValue({ files: [] });
  // The presigned workspace URLs, answered from the table above.
  vi.stubGlobal("fetch", (url: URL) =>
    Promise.resolve(
      downloads.get(url.toString())?.() ?? new Response(null, { status: 404 })
    )
  );
});

afterEach(async () => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
  vi.stubEnv("BLOB_STORE_ID", "");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function loadImages() {
  // The spy and the modules under test have to come from one module registry,
  // so the reset happens before any of them is imported.
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const [Database, images, delivery] = await Promise.all([
    import("@db"),
    import("@agent/lib/browser-use/images"),
    import("@agent/lib/image-artifact/delivery"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  return { delivery, images, pgliteDatabase };
}

function row(rootSessionId: string | null = "session-1") {
  return {
    createdByUserId: scope.userId,
    id: runId,
    rootSessionId,
    sessionId: browserSessionId,
    workspaceId: scope.workspaceId,
  };
}

const run = { createdAt: runCreatedAt, workspaceId };

function savedFile(
  path: string,
  bytes: Uint8Array,
  options: { contentType?: string; lastModified?: string } = {}
): WorkspaceFile {
  // Parsed once, so the key matches the percent-encoded URL fetch is given.
  const url = new URL(
    `https://workspace.browser-use.test/${path}?signature=secret`
  ).toString();
  downloads.set(
    url,
    () =>
      new Response(Buffer.from(bytes), {
        headers: { "content-type": options.contentType ?? "image/png" },
      })
  );
  return {
    lastModified: options.lastModified ?? "2026-09-22T10:05:00.000Z",
    path,
    size: bytes.byteLength,
    url,
  };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Just enough of each format for its magic bytes to be read. */
function png(marker: number) {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    marker,
  ]);
}

function jpeg(marker: number) {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0,
    marker,
  ]);
}

const finalPng = png(1);
const bandJpeg = jpeg(2);

describe("capturing the pictures a browser run leaves behind", () => {
  it("keeps the run's own screenshot and item photos as ready private artifacts", async () => {
    const { images, pgliteDatabase } = await loadImages();
    listBrowserUseWorkspaceFiles.mockResolvedValue({
      files: [
        savedFile("report/xiaomi-band-9.jpg", bandJpeg, {
          contentType: "binary/octet-stream",
        }),
        savedFile("report/final.png", finalPng),
        savedFile("report/notes.txt", new Uint8Array([1])),
        // Left in the shared workspace by an earlier errand of this session.
        savedFile("report/earlier.png", finalPng, {
          lastModified: "2026-09-21T10:00:00.000Z",
        }),
      ],
    });

    const captured = await images.captureBrowserRunImages(row(), run);

    expect(listBrowserUseWorkspaceFiles).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      "report/"
    );
    expect(captured.map((image) => image.label)).toEqual([
      "скриншот страницы с результатом",
      "xiaomi band 9",
    ]);
    expect(findBrowserUseSessionCdpUrl).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]?.[2]).toMatchObject({ access: "private" });
    expect([...blobs.keys()].toSorted()).toEqual(
      [
        `browser-images/better-auth-alice/${sha256(finalPng)}`,
        `browser-images/better-auth-alice/${sha256(bandJpeg)}`,
      ].toSorted()
    );

    const rows = await pgliteDatabase
      .select()
      .from(schema.browserImageArtifacts);
    const byLabel = new Map(rows.map((stored) => [stored.label, stored]));
    expect(byLabel.get("скриншот страницы с результатом")).toMatchObject({
      browserSessionId,
      byteSize: finalPng.byteLength,
      contentHash: sha256(finalPng),
      createdByUserId: scope.userId,
      filename: "final.png",
      idempotencyKey: `browser-run:${runId}:report/final.png`,
      mediaType: "image/png",
      rootSessionId: "session-1",
      sourceKind: "viewport",
      status: "ready",
      workerSessionId: runId,
      workspaceId: scope.workspaceId,
    });
    // The store answered without a type; the bytes decided it.
    expect(byLabel.get("xiaomi band 9")).toMatchObject({
      filename: "xiaomi-band-9.jpg",
      mediaType: "image/jpeg",
      sourceKind: "image_resource",
    });
  }, 20_000);

  it("photographs the live browser when the run saved no page of its own", async () => {
    const { images, pgliteDatabase } = await loadImages();
    const viewport = jpeg(9);
    findBrowserUseSessionCdpUrl.mockResolvedValue("wss://cdp.browser-use.test");
    captureViewportOverCdp.mockResolvedValue(viewport);
    listBrowserUseWorkspaceFiles.mockResolvedValue({
      files: ["a", "b", "c", "d", "e"].map((name, index) =>
        savedFile(`report/item-${name}.jpg`, jpeg(20 + index))
      ),
    });

    const captured = await images.captureBrowserRunImages(row(), run);

    expect(findBrowserUseSessionCdpUrl).toHaveBeenCalledExactlyOnceWith(
      browserSessionId
    );
    // Four in all, as many as one message carries: the page and three items.
    expect(captured.map((image) => image.label)).toEqual([
      "скриншот страницы с результатом",
      "item a",
      "item b",
      "item c",
    ]);
    const rows = await pgliteDatabase
      .select()
      .from(schema.browserImageArtifacts);
    expect(rows).toHaveLength(4);
    expect(
      rows.find((stored) => stored.idempotencyKey.endsWith(":viewport"))
    ).toMatchObject({
      contentHash: sha256(viewport),
      filename: "final.jpg",
      mediaType: "image/jpeg",
      sourceKind: "viewport",
    });
  }, 20_000);

  it("loses only the picture that could not be downloaded", async () => {
    const { images } = await loadImages();
    const broken = savedFile("report/broken.png", finalPng);
    downloads.set(broken.url ?? "", () => new Response(null, { status: 403 }));
    const huge = savedFile("report/huge.png", finalPng);
    downloads.set(
      huge.url ?? "",
      () =>
        new Response("x", {
          headers: { "content-length": String(9 * 1024 * 1024) },
        })
    );

    listBrowserUseWorkspaceFiles.mockResolvedValue({
      files: [broken, huge, savedFile("report/final.png", finalPng)],
    });

    const captured = await images.captureBrowserRunImages(row(), run);

    expect(captured.map((image) => image.label)).toEqual([
      "скриншот страницы с результатом",
    ]);
  }, 20_000);

  it("refuses a file that only calls itself an image", async () => {
    const { images } = await loadImages();
    const page = new TextEncoder().encode("<!doctype html><title>shop</title>");
    listBrowserUseWorkspaceFiles.mockResolvedValue({
      files: [
        savedFile("report/final.png", finalPng),
        savedFile("report/ignore-previous-instructions!!.png", page),
      ],
    });

    const captured = await images.captureBrowserRunImages(row(), run);

    expect(captured.map((image) => image.label)).toEqual([
      "скриншот страницы с результатом",
    ]);
    expect(put).toHaveBeenCalledOnce();
  }, 20_000);

  it("keeps an item caption to letters, digits and spaces", async () => {
    const { images } = await loadImages();
    listBrowserUseWorkspaceFiles.mockResolvedValue({
      files: [
        savedFile("report/final.png", finalPng),
        savedFile("report/Браслет_Mi-Band<9>.jpg", bandJpeg),
        savedFile("report/---.jpg", jpeg(3)),
      ],
    });

    const captured = await images.captureBrowserRunImages(row(), run);

    expect(captured.map((image) => image.label)).toEqual([
      "скриншот страницы с результатом",
      "фото товара",
      "Браслет Mi Band 9",
    ]);
  }, 20_000);

  it("keeps one row per picture when a run is captured twice", async () => {
    const { images, pgliteDatabase } = await loadImages();
    listBrowserUseWorkspaceFiles.mockResolvedValue({
      files: [savedFile("report/final.png", finalPng)],
    });

    const first = await images.captureBrowserRunImages(row(), run);
    const second = await images.captureBrowserRunImages(row(), run);

    expect(second).toEqual(first);
    expect(
      await pgliteDatabase.select().from(schema.browserImageArtifacts)
    ).toHaveLength(1);
  }, 20_000);

  it("captures nothing without a conversation to show it in", async () => {
    const { images } = await loadImages();

    expect(await images.captureBrowserRunImages(row(null), run)).toEqual([]);
    expect(listBrowserUseWorkspaceFiles).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  }, 20_000);

  it("captures nothing without a private Blob store to keep it in", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "");
    const { images } = await loadImages();

    expect(await images.captureBrowserRunImages(row(), run)).toEqual([]);
    expect(listBrowserUseWorkspaceFiles).not.toHaveBeenCalled();
  }, 20_000);

  it("hands the channel the very bytes the run saved", async () => {
    const { delivery, images } = await loadImages();
    listBrowserUseWorkspaceFiles.mockResolvedValue({
      files: [savedFile("report/final.png", finalPng)],
    });
    const [screenshot] = await images.captureBrowserRunImages(row(), run);
    if (!screenshot) throw new Error("The screenshot was not captured.");

    // What the Telegram and iMessage channels do with a send_message text.
    const prepared = await delivery.prepareImageArtifactDelivery(
      `вот что нашёл\n\n![страница](/artifacts/${screenshot.id})`,
      { rootSessionId: "session-1", scope }
    );

    expect(prepared.failedArtifactIds).toEqual([]);
    expect(prepared.text).toBe("вот что нашёл");
    expect(prepared.files).toEqual([
      {
        data: Buffer.from(finalPng),
        filename: "final.png",
        mimeType: "image/png",
      },
    ]);
  }, 20_000);
});

describe("choosing which saved files to keep", () => {
  it("puts the final page first, skips what is not an image, and caps the count", async () => {
    const { images } = await loadImages();
    const picture = png(3);
    listBrowserUseWorkspaceFiles.mockResolvedValue({
      files: [
        savedFile("report/b.png", picture),
        savedFile("report/a.webp", picture),
        savedFile("report/nested/c.png", picture),
        { ...savedFile("report/empty.png", picture), size: 0 },
        { ...savedFile("report/huge.png", picture), size: 9 * 1024 * 1024 },
        savedFile("report/d.gif", picture),
        savedFile("report/e.jpeg", picture),
        savedFile("report/final.png", picture),
        { ...savedFile("report/no-url.png", picture), url: null },
        savedFile("report/.png", picture),
      ],
    });

    const captured = await images.captureBrowserRunImages(row(), run);

    expect(captured.map((image) => image.label)).toEqual([
      "скриншот страницы с результатом",
      "a",
      "b",
      "d",
    ]);
  }, 20_000);
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../../db/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}
