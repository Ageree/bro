import { createHash, randomUUID } from "node:crypto";
import type { readBrowserRun } from "@db/services/browser-runs";
import {
  findBrowserDownloadArtifact,
  saveBrowserDownloadArtifact,
} from "@db/services/browser-downloads";
import {
  artifactStorageConfigured,
  deleteArtifactObject,
  putArtifactObject,
} from "@shared/object-storage/artifacts";
import {
  documentDownloadTimeoutMs,
  downloadWithin,
  type DownloadOptions,
} from "@agent/lib/inbound-media/download";
import {
  documentBytesMatch,
  documentByteCap,
  documentMediaType,
  sniffMediaType,
} from "@agent/lib/inbound-media/media-type";
import { capFilename } from "@agent/lib/outbound-media/attachments";
import {
  resolvePrivateRoute,
  withPrivateRoute,
} from "@agent/lib/browser-vm/private-route";
import { listBrowserUseWorkspaceFiles, type readBrowserUseRun } from "./client";

/**
 * The files a browser run downloaded for the person (a book, a ticket, a
 * statement), turned into private artifacts its report can send. Until 25.10
 * they stayed in the VM's session folder and never reached anyone: a book
 * from Z-Library was downloaded on 24.10, and Bro could only say so.
 *
 * Only the run's own files, as its worker recorded them by the folder before
 * and after it (`run.downloads`), never a URL a model named or a page of the
 * site. Each one is a site's file, so it is untrusted: its type is decided by
 * its bytes against a short list of what a person downloads on an errand —
 * documents, books, pictures and ZIP archives, never a program — and the
 * report gets only its name, type and size, never its text.
 */

/** The folder of the session where Chrome saves what a run downloads. */
const browserRunDownloadPrefix = "downloads/";
/**
 * A file past this is not sent: one message carries 30 MB of artifacts in
 * all (`maximumAttachmentBatchBytes`), Telegram takes a bot's document up to
 * 50 MB, and the bytes are held in memory on the way.
 */
export const maximumBrowserDownloadBytes = documentByteCap;
/** How many files of one run are sent; the rest are named as not sent. */
const maximumBrowserDownloads = 5;
const maximumLabelLength = 80;

/** Books and documents the generic sniff does not know, by extension and bytes. */
const ownTypes: ReadonlyMap<
  string,
  {
    readonly mediaType: string;
    readonly matches: (bytes: Uint8Array) => boolean;
  }
> = new Map([
  ["epub", { matches: isEpub, mediaType: "application/epub+zip" }],
  [
    "fb2",
    { matches: isFictionBook, mediaType: "application/x-fictionbook+xml" },
  ],
  ["mobi", { matches: isMobi, mediaType: "application/x-mobipocket-ebook" }],
  ["azw3", { matches: isMobi, mediaType: "application/vnd.amazon.ebook" }],
  ["djvu", { matches: isDjvu, mediaType: "image/vnd.djvu" }],
  ["rtf", { matches: isRtf, mediaType: "application/rtf" }],
]);

/** The pictures every channel shows; the sniff reads them from the bytes. */
const pictureTypes: ReadonlySet<string> = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type BrowserRunRow = Pick<
  NonNullable<Awaited<ReturnType<typeof readBrowserRun>>>,
  "createdByUserId" | "id" | "rootSessionId" | "workspaceId"
>;

type BrowserUseRunSummary = Pick<
  Awaited<ReturnType<typeof readBrowserUseRun>>,
  "downloads" | "workspaceId"
>;

/** Why a file of the run does not go to the person. */
type NotSent = "failed" | "large" | "many" | "type";

export type BrowserRunDownload =
  | {
      readonly kind: "ready";
      readonly id: string;
      readonly label: string;
      readonly mediaType: string;
      readonly size: number;
    }
  | {
      readonly kind: "refused";
      readonly label: string;
      readonly reason: NotSent;
    };

/**
 * What a file is, by its name and bytes, or `undefined` for anything that is
 * not on the list: a program, a page, an archive of another kind, or bytes
 * that are not what the name claims.
 */
export function browserDownloadMediaType(name: string, bytes: Uint8Array) {
  const extension = extensionOf(name);
  const own = ownTypes.get(extension);
  if (own !== undefined) return own.matches(bytes) ? own.mediaType : undefined;
  const sniffed = sniffMediaType(bytes);
  if (sniffed === "application/pdf") return sniffed;
  if (sniffed !== undefined && pictureTypes.has(sniffed)) return sniffed;
  const document = documentMediaType(name, undefined, { archives: true });
  if (document !== undefined && documentBytesMatch(document, bytes)) {
    return document;
  }
  return undefined;
}

export async function captureBrowserRunDownloads(
  row: BrowserRunRow,
  run: BrowserUseRunSummary
): Promise<BrowserRunDownload[]> {
  const files = (run.downloads ?? []).filter((file) =>
    file.path.startsWith(browserRunDownloadPrefix)
  );
  if (
    files.length === 0 ||
    !row.rootSessionId ||
    !run.workspaceId ||
    !artifactStorageConfigured()
  ) {
    return [];
  }
  const { rootSessionId, workspaceId } = row;
  // The list carries each file's download URL; a file the run recorded that
  // is no longer in the folder is a file that did not come.
  const listed = new Map(
    (
      await listBrowserUseWorkspaceFiles(
        run.workspaceId,
        browserRunDownloadPrefix
      )
    ).files.map((file) => [file.path, file])
  );
  const scope = { userId: row.createdByUserId, workspaceId };
  const results: BrowserRunDownload[] = [];
  // One file at a time: five at the cap together would hold 100 MB.
  /* oxlint-disable eslint/no-await-in-loop -- Sequential on purpose, to bound the bytes held at once. */
  for (const [index, file] of files.entries()) {
    const name = file.path.slice(browserRunDownloadPrefix.length);
    const label = downloadLabel(name);
    if (index >= maximumBrowserDownloads) {
      results.push({ kind: "refused", label, reason: "many" });
      continue;
    }
    if (file.size > maximumBrowserDownloadBytes) {
      results.push({ kind: "refused", label, reason: "large" });
      continue;
    }
    const url = listed.get(file.path)?.url;
    try {
      results.push(
        url
          ? await keepDownload(scope, {
              label,
              name,
              path: file.path,
              rootSessionId,
              row,
              url,
            })
          : { kind: "refused", label, reason: "failed" }
      );
    } catch (error) {
      // The presigned URL is never logged: it is a credential for the file.
      console.warn("[browser-use] a downloaded file could not be kept", {
        cause: error instanceof Error ? error.name : null,
        runId: row.id,
      });
      results.push({ kind: "refused", label, reason: "failed" });
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
  console.info("[browser-use] run downloads", {
    files: results.map((result) =>
      result.kind === "ready"
        ? { mediaType: result.mediaType, size: result.size }
        : { reason: result.reason }
    ),
    runId: row.id,
  });
  return results;
}

async function keepDownload(
  scope: { readonly userId: string; readonly workspaceId: string },
  file: {
    readonly label: string;
    readonly name: string;
    readonly path: string;
    readonly rootSessionId: string;
    readonly row: BrowserRunRow;
    readonly url: string;
  }
): Promise<BrowserRunDownload> {
  const { label, row } = file;
  const stored = await findBrowserDownloadArtifact(scope, {
    browserRunId: row.id,
    path: file.path,
  });
  if (stored) return ready(stored, label);
  // A browser VM's file comes from its worker, one of the project's VMs, so
  // it takes the private route; the address is looked up before the timeout.
  await resolvePrivateRoute(file.url);
  const download = await downloadWithin(
    new URL(file.url),
    maximumBrowserDownloadBytes,
    withPrivateRoute<DownloadOptions>({ timeoutMs: documentDownloadTimeoutMs })
  );
  if (download.kind === "oversize") {
    return { kind: "refused", label, reason: "large" };
  }
  if (download.kind !== "bytes" || download.bytes.byteLength === 0) {
    return { kind: "refused", label, reason: "failed" };
  }
  const mediaType = browserDownloadMediaType(file.name, download.bytes);
  if (mediaType === undefined) {
    return { kind: "refused", label, reason: "type" };
  }
  const id = randomUUID();
  const storagePathname = `browser-downloads/${createHash("sha256")
    .update(scope.workspaceId)
    .digest("hex")
    .slice(0, 32)}/${id}`;
  await putArtifactObject({
    bytes: download.bytes,
    mediaType,
    pathname: storagePathname,
  });
  const saved = await saveBrowserDownloadArtifact(scope, {
    browserRunId: row.id,
    byteSize: download.bytes.byteLength,
    contentHash: createHash("sha256").update(download.bytes).digest("hex"),
    filename: capFilename(deliveredName(file.name)),
    id,
    mediaType,
    path: file.path,
    rootSessionId: file.rootSessionId,
    storagePathname,
  });
  if (saved.id !== id) {
    // A concurrent settle stored the same file first; its copy is the one
    // the artifact points at, so this upload has no reader.
    await deleteArtifactObject(storagePathname).catch(() => undefined);
  }
  return ready(saved, label);
}

function ready(
  artifact: {
    readonly byteSize: number;
    readonly id: string;
    readonly mediaType: string;
  },
  label: string
): BrowserRunDownload {
  return {
    id: artifact.id,
    kind: "ready",
    label,
    mediaType: artifact.mediaType,
    size: artifact.byteSize,
  };
}

/** The name the person's messenger shows: no path, no control characters. */
function deliveredName(filename: string) {
  const clean = filename.replaceAll(/[\p{Cc}\p{Cf}/\\]/gu, "").trim();
  return clean.length > 0 ? clean : "file";
}

/**
 * The name as the report shows it: the site chose it, so only letters,
 * digits, spaces and the punctuation of a file name survive, and not many of
 * them — it is a caption, not a channel for instructions, and it must not
 * close the brackets of the reference it rides in.
 */
function downloadLabel(filename: string) {
  const label = filename
    .replaceAll(/[^\p{L}\p{N} ._,()-]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLabelLength)
    .trim();
  return label.length > 0 ? label : "файл";
}

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** An EPUB is a ZIP whose first entry is an uncompressed `mimetype` naming it. */
function isEpub(bytes: Uint8Array) {
  if (ascii(bytes, 0, 4) !== "PK\u0003\u0004") return false;
  const nameLength = (bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8);
  const extraLength = (bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8);
  const mediaType = "application/epub+zip";
  return (
    ascii(bytes, 30, nameLength) === "mimetype" &&
    ascii(bytes, 30 + nameLength + extraLength, mediaType.length) === mediaType
  );
}

/** FictionBook is XML text whose root is `<FictionBook`. */
function isFictionBook(bytes: Uint8Array) {
  const head = bytes.subarray(0, 4096);
  return (
    !head.includes(0) &&
    Buffer.from(head).toString("utf8").includes("<FictionBook")
  );
}

/** Mobipocket and KF8 carry `BOOKMOBI` as the type and creator of their database. */
function isMobi(bytes: Uint8Array) {
  return ascii(bytes, 60, 8) === "BOOKMOBI";
}

function isDjvu(bytes: Uint8Array) {
  return ascii(bytes, 0, 8) === "AT&TFORM";
}

function isRtf(bytes: Uint8Array) {
  return ascii(bytes, 0, 5) === "{\\rtf";
}
