import { drive, type drive_v3 } from "@googleapis/drive";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { withGoogleAuth } from "./client";

const fileFields =
  "id,name,mimeType,size,modifiedTime,version,webViewLink,owners(displayName,emailAddress)";

/** Drive MIME type filters for the file kinds people ask for by name. */
const kindFilters = {
  document: "mimeType = 'application/vnd.google-apps.document'",
  image: "mimeType contains 'image/'",
  pdf: "mimeType = 'application/pdf'",
  presentation: "mimeType = 'application/vnd.google-apps.presentation'",
  spreadsheet: "mimeType = 'application/vnd.google-apps.spreadsheet'",
} as const;

export const driveSearchInputSchema = z.object({
  kind: z
    .enum(["document", "image", "pdf", "presentation", "spreadsheet"])
    .optional()
    .describe(
      "Only files of this type. For `the latest PDF` pass `pdf` and no query."
    ),
  maxResults: z.number().int().min(1).max(25).default(10),
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Words from the file's name or content, e.g. `passport`. Omit to list the most recently modified files."
    ),
});

type DriveSearchInput = z.output<typeof driveSearchInputSchema>;

export const driveReadInputSchema = z.object({
  fileId: z.string().trim().min(1).max(200),
});

/** A download requested as `arraybuffer`, checked rather than cast. */
const arrayBufferSchema = z.instanceof(ArrayBuffer);

/** Longest text handed to the model from one file. */
const maximumTextCharacters = 50_000;

/**
 * Google-native files have no bytes of their own; each is exported to the
 * format the model reads best.
 */
const exportTypes = new Map([
  ["application/vnd.google-apps.document", "text/plain"],
  ["application/vnd.google-apps.presentation", "text/plain"],
  ["application/vnd.google-apps.spreadsheet", "text/csv"],
]);

const textTypes = new Set([
  "application/json",
  "application/xml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
]);

type DriveFile = ReturnType<typeof minimizeFile>;

function minimizeFile(file: drive_v3.Schema$File) {
  return {
    id: file.id ?? "",
    mimeType: file.mimeType ?? null,
    modifiedTime: file.modifiedTime ?? null,
    name: file.name ?? "",
    owners: (file.owners ?? []).map(
      (owner) => owner.displayName ?? owner.emailAddress ?? ""
    ),
    size: file.size ? Number(file.size) : null,
    version: file.version ?? null,
    webViewLink: file.webViewLink ?? null,
  };
}

/** A Drive query literal: backslashes and single quotes escaped. */
function driveString(value: string) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * Word matches read before sorting. Drive cannot order a `fullText` search, so
 * a word search pages through up to this many matches to find the newest.
 */
const maximumWordMatches = 300;

/** Largest page Drive returns for one `files.list` call. */
const drivePageSize = 100;

/**
 * Files matching the search, newest first. Drive refuses `orderBy` together
 * with a `fullText` term, so a search by words collects its matches page by
 * page and sorts them itself.
 */
export async function searchDrive(
  ctx: ToolContext,
  { kind, maxResults, query }: DriveSearchInput
) {
  const terms = ["trashed = false"];
  if (query !== undefined) {
    const literal = driveString(query);
    terms.push(`(name contains ${literal} or fullText contains ${literal})`);
  }
  if (kind !== undefined) terms.push(kindFilters[kind]);
  const request = {
    fields: `nextPageToken,files(${fileFields})`,
    includeItemsFromAllDrives: true,
    q: terms.join(" and "),
    supportsAllDrives: true,
  };
  return withDrive(ctx, async (client) => {
    if (query === undefined) {
      const { data } = await client.files.list(
        { ...request, orderBy: "modifiedTime desc", pageSize: maxResults },
        { signal: ctx.abortSignal }
      );
      return (data.files ?? []).map(minimizeFile);
    }
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the token of the one before it.
      const { data } = await client.files.list(
        { ...request, pageSize: drivePageSize, pageToken },
        { signal: ctx.abortSignal }
      );
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken !== undefined && files.length < maximumWordMatches);
    return files
      .map(minimizeFile)
      .toSorted((a, b) =>
        (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "")
      )
      .slice(0, maxResults);
  });
}

function decodeText(bytes: ArrayBuffer) {
  const text = new TextDecoder().decode(bytes);
  return {
    text: text.slice(0, maximumTextCharacters),
    truncated: text.length > maximumTextCharacters,
  };
}

/**
 * Reads one Drive file. Google Docs, Sheets, and Slides and plain text files
 * come back as text; images and PDFs within `maxBytes` as bytes; anything
 * else, or anything larger, as metadata alone.
 */
export async function readDriveFile(
  ctx: ToolContext,
  fileId: string,
  maxBytes: number
): Promise<
  | { kind: "text"; file: DriveFile; text: string; truncated: boolean }
  | { kind: "bytes"; file: DriveFile; bytes: Uint8Array }
  | { kind: "metadata"; file: DriveFile; reason: string }
> {
  return withDrive(ctx, async (client) => {
    const options = { signal: ctx.abortSignal };
    const { data } = await client.files.get(
      { fields: fileFields, fileId, supportsAllDrives: true },
      options
    );
    const file = minimizeFile(data);
    const mimeType = file.mimeType ?? "";

    const exportType = exportTypes.get(mimeType);
    if (exportType) {
      const exported = await client.files.export(
        { fileId, mimeType: exportType },
        { ...options, responseType: "arraybuffer" }
      );
      return {
        file,
        kind: "text",
        ...decodeText(arrayBufferSchema.parse(exported.data)),
      };
    }
    if (mimeType.startsWith("application/vnd.google-apps.")) {
      return {
        file,
        kind: "metadata",
        reason: "This Google file type has no text export.",
      };
    }

    const isText = textTypes.has(mimeType) || mimeType.startsWith("text/");
    const isMedia =
      mimeType.startsWith("image/") || mimeType === "application/pdf";
    if (!isText && !isMedia) {
      return {
        file,
        kind: "metadata",
        reason: "Only text, images, and PDFs are downloaded.",
      };
    }
    if ((file.size ?? 0) > maxBytes) {
      return {
        file,
        kind: "metadata",
        reason: "The file is too large to download.",
      };
    }
    const downloaded = await client.files.get(
      { alt: "media", fileId, supportsAllDrives: true },
      { ...options, responseType: "arraybuffer" }
    );
    const buffer = arrayBufferSchema.parse(downloaded.data);
    if (isText) return { file, kind: "text", ...decodeText(buffer) };
    if (buffer.byteLength > maxBytes) {
      return {
        file,
        kind: "metadata",
        reason: "The file is too large to download.",
      };
    }
    return { bytes: new Uint8Array(buffer), file, kind: "bytes" };
  });
}

function withDrive<T>(
  ctx: ToolContext,
  execute: (client: ReturnType<typeof drive>) => Promise<T>
) {
  return withGoogleAuth(ctx, (auth) => execute(drive({ auth, version: "v3" })));
}
