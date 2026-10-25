import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import { accessScopeForUser } from "@shared/identity/access-scope";

const runId = "vm:44444444-4444-4444-8444-444444444444";
const workspaceId = "session-folder";
const scope = accessScopeForUser("better-auth:alice");

interface WorkspaceFile {
  lastModified: string;
  path: string;
  size: number;
  url: string | null;
}

const listBrowserUseWorkspaceFiles = vi.hoisted(() =>
  vi.fn<
    (workspace: string, prefix: string) => Promise<{ files: WorkspaceFile[] }>
  >()
);
const storedObjects = vi.hoisted(
  () => new Map<string, { bytes: Uint8Array; contentType: string }>()
);
const put = vi.hoisted(() =>
  vi.fn<
    (input: {
      bytes: Uint8Array;
      mediaType: string;
      pathname: string;
    }) => Promise<void>
  >((input) => {
    storedObjects.set(input.pathname, {
      bytes: new Uint8Array(input.bytes),
      contentType: input.mediaType,
    });
    return Promise.resolve();
  })
);

vi.mock("@agent/lib/browser-use/client", () => ({
  listBrowserUseWorkspaceFiles,
}));
// A private object store held in memory: what `put` wrote is what `open`
// serves.
vi.mock("@shared/object-storage/artifacts", () => ({
  artifactStorageConfigured: () => true,
  deleteArtifactObject: (pathname: string) => {
    storedObjects.delete(pathname);
    return Promise.resolve();
  },
  openArtifactObject: (pathname: string) => {
    const stored = storedObjects.get(pathname);
    if (!stored) return Promise.resolve(undefined);
    return Promise.resolve({
      contentType: stored.contentType,
      etag: '"etag"',
      size: stored.bytes.byteLength,
      status: 200,
      stream: new Response(Buffer.from(stored.bytes)).body,
    });
  },
  putArtifactObject: put,
}));

const databases: PGlite[] = [];
const served = new Map<string, () => Response>();

beforeEach(() => {
  storedObjects.clear();
  served.clear();
  listBrowserUseWorkspaceFiles.mockResolvedValue({ files: [] });
  vi.stubGlobal("fetch", (url: URL) =>
    Promise.resolve(
      served.get(url.toString())?.() ?? new Response(null, { status: 404 })
    )
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function load() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  await client.exec(
    `INSERT INTO workspaces (id) VALUES ('${scope.workspaceId}');
     INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ('${scope.workspaceId}', '${scope.userId}', 'owner');`
  );
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  const downloads = await import("@agent/lib/browser-use/downloads");
  const delivery = await import("@agent/lib/image-artifact/delivery");
  return { delivery, downloads, pgliteDatabase };
}

const row = {
  createdByUserId: scope.userId,
  id: runId,
  rootSessionId: "session-1",
  workspaceId: scope.workspaceId,
};

function folderFile(path: string, bytes: Uint8Array): WorkspaceFile {
  const url = new URL(
    `https://worker.browser-vm.test/v1/dl/token/s/${path}`
  ).toString();
  served.set(url, () => new Response(Buffer.from(bytes)));
  return {
    lastModified: "2026-10-25T10:00:00Z",
    path,
    size: bytes.byteLength,
    url,
  };
}

/** An EPUB's first entry: the uncompressed `mimetype` naming the format. */
function epub() {
  const name = Buffer.from("mimetype");
  const header = Buffer.alloc(30);
  header.write("PK\u0003\u0004", 0, "latin1");
  header.writeUInt16LE(name.length, 26);
  return new Uint8Array(
    Buffer.concat([
      header,
      name,
      Buffer.from("application/epub+zip"),
      Buffer.from("…the rest of the book"),
    ])
  );
}

const program = new Uint8Array(
  Buffer.concat([Buffer.from("MZ\u0090\u0000"), Buffer.alloc(64)])
);

describe(
  "sending the files a browser run downloaded",
  { timeout: 30_000 },
  () => {
    it("turns the run's book into an artifact the report sends as a document", async () => {
      const { delivery, downloads, pgliteDatabase } = await load();
      const book = epub();
      listBrowserUseWorkspaceFiles.mockResolvedValue({
        files: [
          folderFile("downloads/Pride and Prejudice.epub", book),
          // An earlier errand's file in the same folder: not this run's.
          folderFile("downloads/earlier.pdf", new Uint8Array([0x25, 0x50])),
        ],
      });

      const captured = await downloads.captureBrowserRunDownloads(row, {
        downloads: [
          { path: "downloads/Pride and Prejudice.epub", size: book.byteLength },
        ],
        workspaceId,
      });

      expect(listBrowserUseWorkspaceFiles).toHaveBeenCalledExactlyOnceWith(
        workspaceId,
        "downloads/"
      );
      const [stored] = await pgliteDatabase
        .select()
        .from(schema.browserDownloadArtifacts);
      expect(captured).toEqual([
        {
          id: stored?.id,
          kind: "ready",
          label: "Pride and Prejudice.epub",
          mediaType: "application/epub+zip",
          size: book.byteLength,
        },
      ]);
      expect(stored).toMatchObject({
        browserRunId: runId,
        filename: "Pride and Prejudice.epub",
        path: "downloads/Pride and Prejudice.epub",
        rootSessionId: "session-1",
      });

      const ready = captured[0];
      if (ready?.kind !== "ready") throw new Error("the book was not kept");
      const prepared = await delivery.prepareImageArtifactDelivery(
        `Вот книга\n\n![Pride and Prejudice.epub](/artifacts/${ready.id})`,
        { rootSessionId: "session-1", scope }
      );
      expect(prepared.failedArtifactIds).toEqual([]);
      expect(prepared.files).toEqual([
        {
          data: Buffer.from(book),
          filename: "Pride and Prejudice.epub",
          kind: "document",
          mimeType: "application/epub+zip",
        },
      ]);
      // Another conversation of the same person does not get it.
      const elsewhere = await delivery.prepareImageArtifactDelivery(
        `![книга](/artifacts/${ready.id})`,
        { rootSessionId: "session-2", scope }
      );
      expect(elsewhere.files).toEqual([]);

      // A settle read twice keeps the one copy.
      const again = await downloads.captureBrowserRunDownloads(row, {
        downloads: [
          { path: "downloads/Pride and Prejudice.epub", size: book.byteLength },
        ],
        workspaceId,
      });
      expect(again).toEqual(captured);
      expect(put).toHaveBeenCalledOnce();
    });

    it("does not send a program named as a book, nor a file past the cap", async () => {
      const { downloads, pgliteDatabase } = await load();
      listBrowserUseWorkspaceFiles.mockResolvedValue({
        files: [folderFile("downloads/book.epub", program)],
      });

      const captured = await downloads.captureBrowserRunDownloads(row, {
        downloads: [
          { path: "downloads/book.epub", size: program.byteLength },
          { path: "downloads/huge.pdf", size: 21 * 1024 * 1024 },
        ],
        workspaceId,
      });

      expect(captured).toEqual([
        { kind: "refused", label: "book.epub", reason: "type" },
        { kind: "refused", label: "huge.pdf", reason: "large" },
      ]);
      expect(put).not.toHaveBeenCalled();
      expect(
        await pgliteDatabase.select().from(schema.browserDownloadArtifacts)
      ).toEqual([]);
    });

    it("reads nothing for a run its worker recorded no download of", async () => {
      const { downloads } = await load();

      expect(
        await downloads.captureBrowserRunDownloads(row, { workspaceId })
      ).toEqual([]);
      expect(listBrowserUseWorkspaceFiles).not.toHaveBeenCalled();
    });

    it("tells the types it sends from their bytes", async () => {
      const { downloads } = await load();
      const type = downloads.browserDownloadMediaType;

      expect(type("ticket.pdf", new TextEncoder().encode("%PDF-1.7\n%…"))).toBe(
        "application/pdf"
      );
      expect(type("book.epub", epub())).toBe("application/epub+zip");
      expect(
        type(
          "book.fb2",
          new TextEncoder().encode('<?xml version="1.0"?><FictionBook xmlns=')
        )
      ).toBe("application/x-fictionbook+xml");
      expect(type("setup.exe", program)).toBeUndefined();
      expect(
        type("page.html", new TextEncoder().encode("<!doctype html><html>…"))
      ).toBeUndefined();
    });
  }
);

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
