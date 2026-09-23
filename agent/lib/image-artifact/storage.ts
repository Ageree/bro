import { createHash } from "node:crypto";
import { BlobNotFoundError, get, head, put } from "@vercel/blob";
import type { AccessScope } from "@shared/identity/access-scope";
import { readReadyArtifact } from "@db/services/artifacts";
import { sniffMediaType } from "@agent/lib/inbound-media/media-type";
import { maximumBrowserImageBytes } from "@shared/browser/artifact";
import { env } from "@shared/environment";

/** Where private images live in the Blob store. */
const storagePrefix = "browser-images";
const storageCacheSeconds = 365 * 24 * 60 * 60;

/** The image types every channel can show, with the extension each is filed
 *  under. Anything else is not kept, whatever its name claimed. */
const imageExtensions = new Map([
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
/** A reference photo only travels to an image model, which also reads the
 *  HEIC an iPhone sends; it is never shown in a chat. */
const referenceImageExtensions = new Map([
  ...imageExtensions,
  ["image/heic", "heic"],
  ["image/heif", "heif"],
]);

/** What a private image is checked against when it is read back. */
interface StoredImage {
  readonly byteSize: number;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly storagePathname: string;
}

/**
 * Whether there is a private Blob store to put images in. Without one an
 * artifact row could be written but never served, so nothing is stored.
 */
export function imageArtifactStorageConfigured() {
  return (
    env.BLOB_STORE_ID !== undefined || env.BLOB_READ_WRITE_TOKEN !== undefined
  );
}

/**
 * Puts image bytes into the private store under their content hash: the same
 * picture stored twice lands on the same object, which is why overwriting is
 * allowed — the bytes are identical by construction. A `reference` photo,
 * kept only to hand to an image model, may be HEIC and is not uploaded again
 * when its object is already there.
 *
 * The media type is read from the bytes, never taken from a file name or a
 * header: a page saved as `.png` is still a page, and the channels would
 * upload it to a person as a photo that does not open.
 */
export async function storePrivateImage(
  scope: AccessScope,
  bytes: Uint8Array,
  options: { readonly reference?: boolean } = {}
) {
  if (bytes.byteLength === 0) {
    throw new Error("An image artifact cannot be empty.");
  }
  if (bytes.byteLength > maximumBrowserImageBytes) {
    throw new Error("The image is larger than an artifact may be.");
  }
  const mediaType = sniffMediaType(bytes);
  const extensions = options.reference
    ? referenceImageExtensions
    : imageExtensions;
  const extension =
    mediaType === undefined ? undefined : extensions.get(mediaType);
  if (mediaType === undefined || extension === undefined) {
    throw new Error("The file is not an image an artifact may hold.");
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const stored = {
    byteSize: bytes.byteLength,
    contentHash,
    extension,
    mediaType,
    storagePathname: `${storagePrefix}/${storageSegment(scope.userId)}/${contentHash}`,
  };
  if (options.reference && (await isStored(stored.storagePathname))) {
    return stored;
  }
  await put(stored.storagePathname, Buffer.from(bytes), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: storageCacheSeconds,
    contentType: mediaType,
  });
  return stored;
}

async function isStored(pathname: string) {
  try {
    await head(pathname);
    return true;
  } catch (error) {
    if (error instanceof BlobNotFoundError) return false;
    throw error;
  }
}

/**
 * Reads an `/artifacts/<id>` image of this user and session back, checked
 * against the size, type and hash its row recorded.
 */
export async function readImageArtifact(
  scope: AccessScope,
  artifactId: string,
  options: {
    readonly maximumBytes: number;
    readonly rootSessionId: string;
    readonly signal?: AbortSignal;
  }
) {
  const artifact = await readReadyArtifact(scope, artifactId, {
    rootSessionId: options.rootSessionId,
  });
  if (!artifact || artifact.byteSize > options.maximumBytes) return undefined;
  const bytes = await readPrivateImage(artifact, options.signal);
  if (!bytes) return undefined;
  return {
    bytes,
    filename: artifact.filename,
    id: artifact.id,
    mediaType: artifact.mediaType,
  };
}

/**
 * Reads a private image back only when its bytes are still exactly what was
 * stored: the size and type the store reports and the hash of what streamed.
 */
export async function readPrivateImage(
  stored: StoredImage,
  signal?: AbortSignal
) {
  if (!imageArtifactStorageConfigured()) return undefined;
  const result = await get(stored.storagePathname, {
    abortSignal: signal,
    access: "private",
  });
  if (result?.statusCode !== 200) return undefined;
  if (
    result.blob.size !== stored.byteSize ||
    result.blob.contentType !== stored.mediaType
  )
    return undefined;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    /* oxlint-disable eslint/no-await-in-loop -- Blob response chunks form an ordered stream. */
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > stored.byteSize) return undefined;
      chunks.push(value);
    }
    /* oxlint-enable eslint/no-await-in-loop */
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== stored.contentHash)
    return undefined;
  return bytes;
}

// A user id such as `better-auth:…` carries a colon; the path segment keeps
// only what every object store and URL treats as plain.
function storageSegment(userId: string) {
  return userId.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
}
