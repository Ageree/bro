import {
  FILE_BINARY_MAX,
  FILE_TEXT_READ_MAX,
  FILE_TEXT_WRITE_MAX,
  sanitizeFileName,
} from "../../convex/lib/fileStore.ts";
import {
  deleteStoredFile,
  generateFileUploadUrl,
  getStoredFile,
  listStoredFiles,
  saveStoredFile,
  storeFileBytes,
  type StoredFile,
  type StoredFileWithUrl,
} from "./convex.ts";

export {
  FILE_BINARY_MAX,
  FILE_TEXT_READ_MAX,
  FILE_TEXT_WRITE_MAX,
  sanitizeFileName,
};

export class FileError extends Error {
  readonly status: "invalid" | "denied" | "error";

  constructor(status: FileError["status"], message: string) {
    super(message);
    this.name = "FileError";
    this.status = status;
  }
}

export function fileFailure(err: unknown): { status: string; error: string } {
  if (err instanceof FileError) {
    return { status: err.status, error: err.message };
  }
  return {
    status: "error",
    error: err instanceof Error ? err.message : "file failed",
  };
}

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i;

export function isTextMime(mimeType: string): boolean {
  return TEXT_MIME.test(mimeType) || mimeType === "application/csv";
}

export async function uploadFileBytes(
  phoneE164: string,
  args: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    sourceChannel?: StoredFile["sourceChannel"];
  },
): Promise<StoredFile> {
  const name = sanitizeFileName(args.name);
  if (args.bytes.byteLength > FILE_BINARY_MAX) {
    throw new FileError("invalid", "file exceeds 8MB");
  }
  if (args.bytes.byteLength <= FILE_TEXT_WRITE_MAX) {
    const saved = await storeFileBytes(phoneE164, {
      name,
      mimeType: args.mimeType,
      bytes: args.bytes,
      sourceChannel: args.sourceChannel,
    });
    if (!saved) throw new FileError("error", "could not save file");
    return saved;
  }
  const uploadUrl = await generateFileUploadUrl(phoneE164);
  if (!uploadUrl) throw new FileError("error", "could not start upload");
  const posted = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": args.mimeType || "application/octet-stream" },
    body: Buffer.from(args.bytes),
  });
  if (!posted.ok) {
    throw new FileError("error", `upload failed (${posted.status})`);
  }
  const payload = (await posted.json()) as { storageId?: string };
  if (!payload.storageId) throw new FileError("error", "upload missing storageId");
  const saved = await saveStoredFile(phoneE164, {
    storageId: payload.storageId,
    name,
    mimeType: args.mimeType,
    size: args.bytes.byteLength,
    sourceChannel: args.sourceChannel,
  });
  if (!saved) throw new FileError("error", "could not save file");
  return saved;
}

export async function saveTextFile(
  phoneE164: string,
  args: { name: string; content: string; mimeType?: string },
): Promise<StoredFile> {
  const bytes = Buffer.from(args.content, "utf8");
  if (bytes.byteLength > FILE_TEXT_WRITE_MAX) {
    throw new FileError("invalid", "content exceeds 256KB");
  }
  return await uploadFileBytes(phoneE164, {
    name: args.name,
    mimeType: args.mimeType ?? "text/plain; charset=utf-8",
    bytes,
    sourceChannel: "agent",
  });
}

export async function readStoredFileBytes(
  phoneE164: string,
  ref: { fileId?: string; name?: string },
): Promise<{ file: StoredFileWithUrl; bytes: Uint8Array }> {
  const file = await getStoredFile(phoneE164, ref);
  if (!file) throw new FileError("invalid", "file not found");
  if (!file.url) throw new FileError("error", "file has no download url");
  const res = await fetch(file.url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new FileError("error", `could not read file (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > FILE_BINARY_MAX) {
    throw new FileError("invalid", "file exceeds 8MB");
  }
  return { file, bytes: buf };
}

export async function previewStoredFile(
  phoneE164: string,
  ref: { fileId?: string; name?: string },
): Promise<{
  file: StoredFileWithUrl;
  content?: string;
  truncated?: boolean;
}> {
  const file = await getStoredFile(phoneE164, ref);
  if (!file) throw new FileError("invalid", "file not found");
  if (!file.url || !isTextMime(file.mimeType) || file.size > FILE_TEXT_READ_MAX) {
    return { file };
  }
  const res = await fetch(file.url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return { file };
  const text = await res.text();
  if (text.length > FILE_TEXT_READ_MAX) {
    return { file, content: text.slice(0, FILE_TEXT_READ_MAX), truncated: true };
  }
  return { file, content: text };
}

export { deleteStoredFile, listStoredFiles, getStoredFile };
