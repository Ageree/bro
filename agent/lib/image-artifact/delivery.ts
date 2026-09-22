import { createHash } from "node:crypto";
import { get } from "@vercel/blob";
import type { AccessScope } from "@shared/identity/access-scope";
import { readReadyArtifact } from "@db/services/artifacts";
import { env } from "@shared/environment";
import {
  maximumAttachmentBatchBytes,
  outboundFileKind,
  type OutboundFile,
} from "../outbound-media/attachments";
import {
  extractImageArtifactMarkdownReferences,
  stripImageArtifactMarkdownReferences,
} from "./markdown";

/**
 * How many artifacts one message may carry: the Telegram album limit, the
 * same cap `send_message` attachments use.
 */
const maximumArtifactsPerMessage = 10;
/** How many images one browser run may save for the person. */
export const maximumDeliveredImageArtifacts = 4;
/** Accusative forms of «картинка» for one, a few, and many. */
const imageCountForms = ["картинку", "картинки", "картинок"] as const;

/**
 * The line a person reads when an image the message referenced could not be
 * attached. Russian picks the noun form from the count, so the count decides
 * the wording rather than the caller.
 */
export function imageArtifactFailureText(count: number) {
  if (count < 1) return "";
  if (count === 1) return "Не получилось приложить картинку.";
  return `Не получилось приложить ${String(count)} ${imageCountForm(count)}.`;
}

function imageCountForm(count: number) {
  const remainderOfHundred = count % 100;
  if (remainderOfHundred >= 11 && remainderOfHundred <= 14) {
    return imageCountForms[2];
  }
  const remainderOfTen = count % 10;
  if (remainderOfTen === 1) return imageCountForms[0];
  if (remainderOfTen >= 2 && remainderOfTen <= 4) return imageCountForms[1];
  return imageCountForms[2];
}

export async function prepareImageArtifactDelivery(
  message: string,
  input: {
    readonly rootSessionId: string;
    readonly scope: AccessScope;
    readonly signal?: AbortSignal;
  }
) {
  const references = extractImageArtifactMarkdownReferences(message);
  if (references.length === 0) {
    return { failedArtifactIds: [], files: [], text: message };
  }

  // One artifact at a time, within the byte budget URL attachments get, so a
  // message of ten mail attachments cannot buffer its way out of memory.
  const files: OutboundFile[] = [];
  const failedArtifactIds: string[] = [];
  let remainingBytes = maximumAttachmentBatchBytes;
  /* oxlint-disable eslint/no-await-in-loop -- Each read sees what the message has already spent. */
  for (const reference of references.slice(0, maximumArtifactsPerMessage)) {
    const image = await readImageArtifact(input.scope, reference.id, {
      maximumBytes: remainingBytes,
      rootSessionId: input.rootSessionId,
      signal: input.signal,
    }).catch(() => undefined);
    if (!image) {
      failedArtifactIds.push(reference.id);
      continue;
    }
    remainingBytes -= image.bytes.byteLength;
    files.push({
      data: Buffer.from(
        image.bytes.buffer,
        image.bytes.byteOffset,
        image.bytes.byteLength
      ),
      filename: image.filename,
      // A mail attachment can be a PDF or a video rather than a photo.
      kind: outboundFileKind(image.mediaType),
      mimeType: image.mediaType,
    });
  }
  /* oxlint-enable eslint/no-await-in-loop */
  failedArtifactIds.push(
    ...references
      .slice(maximumArtifactsPerMessage)
      .map((reference) => reference.id)
  );

  return {
    failedArtifactIds,
    files,
    text: stripImageArtifactMarkdownReferences(message),
  };
}

async function readImageArtifact(
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
  if (!env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) return undefined;
  const result = await get(artifact.storagePathname, {
    access: "private",
    abortSignal: options.signal,
  });
  if (result?.statusCode !== 200) return undefined;
  if (
    result.blob.size !== artifact.byteSize ||
    result.blob.contentType !== artifact.mediaType
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
      if (total > artifact.byteSize) return undefined;
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
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.contentHash)
    return undefined;
  return {
    bytes,
    filename: artifact.filename,
    id: artifact.id,
    mediaType: artifact.mediaType,
  };
}
