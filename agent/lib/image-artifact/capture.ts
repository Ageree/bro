import { createHash } from "node:crypto";
import { put } from "@vercel/blob";
import type { AccessScope } from "@shared/identity/access-scope";
import { createReadyBrowserImageArtifact } from "@db/services/browser-images";
import { sniffMediaType } from "@agent/lib/inbound-media/media-type";
import {
  maximumBrowserImageBytes,
  type browserImageSourceKinds,
} from "@shared/browser/artifact";
import { env } from "@shared/environment";

/** Where captured images live in the private Blob store. */
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

export interface ImageArtifactCapture {
  readonly browserSessionId: string;
  readonly bytes: Uint8Array;
  readonly idempotencyKey: string;
  readonly label: string;
  /** The file name without an extension; the bytes decide the extension. */
  readonly name: string;
  readonly rootSessionId: string;
  readonly sourceKind: (typeof browserImageSourceKinds)[number];
  readonly workerSessionId: string;
}

/**
 * Whether there is a private Blob store to put images in. Without one the
 * artifact row could be written but never served, so nothing is captured.
 */
export function imageArtifactStorageConfigured() {
  return (
    env.BLOB_STORE_ID !== undefined || env.BLOB_READ_WRITE_TOKEN !== undefined
  );
}

/**
 * The bytes go into the private store first and the ready row second, so a
 * row never points at an image that is not there. The pathname is the content
 * hash: the same picture captured twice lands on the same object, which is why
 * overwriting is allowed — the bytes are identical by construction.
 *
 * The media type is read from the bytes, never taken from a file name or a
 * header: a page saved as `.png` is still a page, and the channels would
 * upload it to a person as a photo that does not open.
 */
export async function captureImageArtifact(
  scope: AccessScope,
  input: ImageArtifactCapture
) {
  if (input.bytes.byteLength === 0) {
    throw new Error("An image artifact cannot be empty.");
  }
  if (input.bytes.byteLength > maximumBrowserImageBytes) {
    throw new Error("The image is larger than an artifact may be.");
  }
  const mediaType = sniffMediaType(input.bytes);
  const extension =
    mediaType === undefined ? undefined : imageExtensions.get(mediaType);
  if (mediaType === undefined || extension === undefined) {
    throw new Error("The file is not an image an artifact may hold.");
  }
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const storagePathname = `${storagePrefix}/${storageSegment(scope.userId)}/${contentHash}`;
  await put(storagePathname, Buffer.from(input.bytes), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: storageCacheSeconds,
    contentType: mediaType,
  });
  const row = await createReadyBrowserImageArtifact(scope, {
    browserSessionId: input.browserSessionId,
    byteSize: input.bytes.byteLength,
    contentHash,
    filename: `${input.name}.${extension}`,
    idempotencyKey: input.idempotencyKey,
    label: input.label,
    mediaType,
    rootSessionId: input.rootSessionId,
    sourceKind: input.sourceKind,
    storagePathname,
    workerSessionId: input.workerSessionId,
  });
  return { id: row.id, label: row.label };
}

// A user id such as `better-auth:…` carries a colon; the path segment keeps
// only what every object store and URL treats as plain.
function storageSegment(userId: string) {
  return userId.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
}
