import type { AccessScope } from "@shared/identity/access-scope";
import { readReadyBrowserImageArtifact } from "./browser-images";
import { readDriveFileArtifact } from "./drive-files";
import { readGeneratedImageArtifact } from "./generated-images";
import { readGmailAttachmentArtifact } from "./gmail-attachments";

/**
 * Resolves `/artifacts/<id>` for one workspace user. An artifact is a browser
 * image, a Gmail attachment, a picture `generate_image` drew, or a Drive
 * file; all are private Blob objects that travel by the same reference and
 * are served and delivered the same way.
 */
export async function readReadyArtifact(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {}
) {
  const browserImage = await readReadyBrowserImageArtifact(
    scope,
    artifactId,
    options
  );
  if (browserImage) {
    const { byteSize, contentHash, filename, mediaType } = browserImage;
    if (!byteSize || !contentHash || !filename || !mediaType) return undefined;
    return {
      byteSize,
      contentHash,
      filename,
      id: browserImage.id,
      mediaType,
      storagePathname: browserImage.storagePathname,
    };
  }
  const attachment =
    (await readGmailAttachmentArtifact(scope, artifactId, options)) ??
    (await readGeneratedImageArtifact(scope, artifactId, options)) ??
    (await readDriveFileArtifact(scope, artifactId, options));
  if (!attachment) return undefined;
  return {
    byteSize: attachment.byteSize,
    contentHash: attachment.contentHash,
    filename: attachment.filename,
    id: attachment.id,
    mediaType: attachment.mediaType,
    storagePathname: attachment.storagePathname,
  };
}
