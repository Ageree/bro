import { createHash } from "node:crypto";
import { get } from "@vercel/blob";
import type { AccessScope } from "@shared/identity/access-scope";
import { readReadyArtifact } from "@db/services/artifacts";
import { env } from "@shared/environment";
import {
  outboundFileKind,
  type OutboundFile,
} from "../outbound-media/attachments";
import {
  extractImageArtifactMarkdownReferences,
  stripImageArtifactMarkdownReferences,
} from "./markdown";

// Ten is the Telegram album limit, the same cap `send_message` attachments use.
const maximumDeliveredImageArtifacts = 10;
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

  const selected = references.slice(0, maximumDeliveredImageArtifacts);
  const loaded = await Promise.all(
    selected.map(async (reference) => ({
      image: await readImageArtifact(input.scope, reference.id, {
        rootSessionId: input.rootSessionId,
        signal: input.signal,
      }).catch(() => undefined),
      reference,
    }))
  );
  const failedArtifactIds = [
    ...loaded
      .filter((item) => item.image === undefined)
      .map((item) => item.reference.id),
    ...references
      .slice(maximumDeliveredImageArtifacts)
      .map((reference) => reference.id),
  ];
  const files = loaded.flatMap(({ image }) =>
    image
      ? [
          {
            data: Buffer.from(image.bytes),
            filename: image.filename,
            // A mail attachment can be a PDF or a video rather than a photo.
            kind: outboundFileKind(image.mediaType),
            mimeType: image.mediaType,
          } satisfies OutboundFile,
        ]
      : []
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
  options: { readonly rootSessionId: string; readonly signal?: AbortSignal }
) {
  const artifact = await readReadyArtifact(scope, artifactId, {
    rootSessionId: options.rootSessionId,
  });
  if (!artifact) return undefined;
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
