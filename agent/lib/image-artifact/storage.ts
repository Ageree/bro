import { createHash } from "node:crypto";
import type { AccessScope } from "@shared/identity/access-scope";
import { readReadyArtifact } from "@db/services/artifacts";
import { sniffMediaType } from "@agent/lib/inbound-media/media-type";
import { maximumBrowserImageBytes } from "@shared/browser/artifact";
import {
  artifactStorageConfigured,
  openArtifactObject,
  putArtifactObject,
} from "@shared/object-storage/artifacts";

/**
 * The folder for each kind of private image. Browser captures keep the
 * folder their existing objects already live in.
 */
const storageFolders = {
  browser: "browser-images",
  generated: "generated-images",
  reference: "reference-photos",
} as const;

type PrivateImageKind = keyof typeof storageFolders;

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
 * Where image bytes live in the private store, without touching it: the path
 * is the content hash, so the same picture always names the same object.
 *
 * The media type is read from the bytes, never taken from a file name or a
 * header: a page saved as `.png` is still a page, and the channels would
 * upload it to a person as a photo that does not open.
 */
export function describePrivateImage(
  scope: AccessScope,
  bytes: Uint8Array,
  kind: PrivateImageKind
) {
  if (bytes.byteLength === 0) {
    throw new Error("An image artifact cannot be empty.");
  }
  if (bytes.byteLength > maximumBrowserImageBytes) {
    throw new Error("The image is larger than an artifact may be.");
  }
  const mediaType = sniffMediaType(bytes);
  const extensions =
    kind === "reference" ? referenceImageExtensions : imageExtensions;
  const extension =
    mediaType === undefined ? undefined : extensions.get(mediaType);
  if (mediaType === undefined || extension === undefined) {
    throw new Error("The file is not an image an artifact may hold.");
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return {
    byteSize: bytes.byteLength,
    contentHash,
    extension,
    mediaType,
    storagePathname: `${storageFolders[kind]}/${storageSegment(scope.userId)}/${contentHash}`,
  };
}

/**
 * Puts image bytes into the private store under their content hash. The same
 * picture stored twice lands on the same object, which is why overwriting is
 * allowed — the bytes are identical by construction.
 */
export async function storePrivateImage(
  scope: AccessScope,
  bytes: Uint8Array,
  kind: PrivateImageKind
) {
  const stored = describePrivateImage(scope, bytes, kind);
  await putArtifactObject({
    bytes,
    mediaType: stored.mediaType,
    pathname: stored.storagePathname,
  });
  return stored;
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
  if (!artifactStorageConfigured()) return undefined;
  const result = await openArtifactObject(stored.storagePathname, { signal });
  if (result?.status !== 200) return undefined;
  if (
    result.size !== stored.byteSize ||
    result.contentType !== stored.mediaType
  ) {
    await result.stream.cancel();
    return undefined;
  }
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    /* oxlint-disable eslint/no-await-in-loop -- Response chunks form an ordered stream. */
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
