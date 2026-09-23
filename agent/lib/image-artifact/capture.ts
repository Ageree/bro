import type { AccessScope } from "@shared/identity/access-scope";
import { createReadyBrowserImageArtifact } from "@db/services/browser-images";
import type { browserImageSourceKinds } from "@shared/browser/artifact";
import { storePrivateImage } from "./storage";

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
 * The bytes go into the private store first and the ready row second, so a
 * row never points at an image that is not there.
 */
export async function captureImageArtifact(
  scope: AccessScope,
  input: ImageArtifactCapture
) {
  const stored = await storePrivateImage(scope, input.bytes);
  const row = await createReadyBrowserImageArtifact(scope, {
    browserSessionId: input.browserSessionId,
    byteSize: stored.byteSize,
    contentHash: stored.contentHash,
    filename: `${input.name}.${stored.extension}`,
    idempotencyKey: input.idempotencyKey,
    label: input.label,
    mediaType: stored.mediaType,
    rootSessionId: input.rootSessionId,
    sourceKind: input.sourceKind,
    storagePathname: stored.storagePathname,
    workerSessionId: input.workerSessionId,
  });
  return { id: row.id, label: row.label };
}
