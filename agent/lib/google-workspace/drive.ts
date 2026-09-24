import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { googleUrl, withGoogleAuth } from "./client";

/** The Google Drive REST API. */
const driveApi = "https://www.googleapis.com/drive/v3";

const fileFields =
  "id,name,mimeType,size,modifiedTime,version,webViewLink,owners(displayName,emailAddress)";

/** A Drive file as Google returns it, the fields Bro asks for. */
const driveFileSchema = z.object({
  id: z.string().optional(),
  mimeType: z.string().optional(),
  modifiedTime: z.string().optional(),
  name: z.string().optional(),
  owners: z
    .array(
      z.object({
        displayName: z.string().optional(),
        emailAddress: z.string().optional(),
      })
    )
    .optional(),
  // Drive sends sizes and versions as decimal strings.
  size: z.string().optional(),
  version: z.string().optional(),
  webViewLink: z.string().optional(),
});

type GoogleDriveFile = z.infer<typeof driveFileSchema>;

const driveFileListSchema = z.object({
  files: z.array(driveFileSchema).optional(),
  nextPageToken: z.string().optional(),
});

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

function minimizeFile(file: GoogleDriveFile) {
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
  return withGoogleAuth(ctx, async (google) => {
    if (query === undefined) {
      const listed = await google.json(driveFileListSchema, {
        url: googleUrl(driveApi, "/files", {
          ...request,
          orderBy: "modifiedTime desc",
          pageSize: maxResults,
        }),
      });
      return (listed.files ?? []).map(minimizeFile);
    }
    const files: GoogleDriveFile[] = [];
    let pageToken: string | undefined;
    do {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the token of the one before it.
      const listed = await google.json(driveFileListSchema, {
        url: googleUrl(driveApi, "/files", {
          ...request,
          pageSize: drivePageSize,
          pageToken,
        }),
      });
      files.push(...(listed.files ?? []));
      pageToken = listed.nextPageToken;
    } while (pageToken !== undefined && files.length < maximumWordMatches);
    return files
      .map(minimizeFile)
      .toSorted((a, b) =>
        (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "")
      )
      .slice(0, maxResults);
  });
}

function decodeText(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  return {
    text: text.slice(0, maximumTextCharacters),
    truncated: text.length > maximumTextCharacters,
  };
}

/**
 * Text downloads may be larger than a file Bro forwards; the model only ever
 * reads the first {@link maximumTextCharacters} of them.
 */
const maximumTextBytes = 20 * 1024 * 1024;

const tooLarge = "The file is too large to download.";

/**
 * Reads one Drive file. Google Docs, Sheets, and Slides and plain text files
 * come back as text; images and PDFs within `maxBytes` as bytes; anything
 * else, or anything larger, as metadata alone. Composio's proxy hands a file
 * over as a short-lived download link, and text as the text itself.
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
  const fileUrl = (query: Parameters<typeof googleUrl>[2]) =>
    googleUrl(driveApi, `/files/${encodeURIComponent(fileId)}`, query);
  return withGoogleAuth(ctx, async (google) => {
    const file = minimizeFile(
      await google.json(driveFileSchema, {
        url: fileUrl({ fields: fileFields, supportsAllDrives: true }),
      })
    );
    const mimeType = file.mimeType ?? "";

    const exportType = exportTypes.get(mimeType);
    if (exportType) {
      const exported = await google.download(
        googleUrl(driveApi, `/files/${encodeURIComponent(fileId)}/export`, {
          mimeType: exportType,
        }),
        maximumTextBytes
      );
      return exported.kind === "oversize"
        ? { file, kind: "metadata", reason: tooLarge }
        : { file, kind: "text", ...decodeText(exported.bytes) };
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
    const limit = isText ? maximumTextBytes : maxBytes;
    if ((file.size ?? 0) > limit) {
      return { file, kind: "metadata", reason: tooLarge };
    }
    const downloaded = await google.download(
      fileUrl({ alt: "media", supportsAllDrives: true }),
      limit
    );
    if (downloaded.kind === "oversize") {
      return { file, kind: "metadata", reason: tooLarge };
    }
    if (isText) return { file, kind: "text", ...decodeText(downloaded.bytes) };
    if (!downloaded.file) {
      // An image or PDF that came back as text lost its bytes on the way.
      return {
        file,
        kind: "metadata",
        reason: "The file could not be downloaded.",
      };
    }
    return { bytes: downloaded.bytes, file, kind: "bytes" };
  });
}
