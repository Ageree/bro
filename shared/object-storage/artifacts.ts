import {
  objectStorageConfigured,
  presignStoredObject,
} from "@shared/object-storage/s3";

/**
 * The bytes behind `/artifacts/<id>`: images Bro captured, generated or was
 * sent, and files copied from Gmail and Drive. Each lives in Object Storage
 * under `artifacts/` plus the `storage_pathname` its row records, so the
 * rows written while the files lived in Vercel Blob still name them
 * (`scripts/cloudru-app-host/blob-to-s3.ts` copied them under the same key).
 */
const artifactKeyPrefix = "artifacts/";
const requestTimeoutMs = 60_000;
/** A presigned URL here is used at once, by the server that signed it. */
const presignSeconds = 300;

/**
 * Whether artifacts can be stored and read on this deployment. Without a
 * store an artifact row could be written but never served.
 */
export function artifactStorageConfigured() {
  return objectStorageConfigured();
}

/** A refusal of Object Storage while storing or reading an artifact. */
export class ArtifactStorageError extends Error {
  readonly status: number;

  constructor(status: number, method: string) {
    super(`Object Storage ${String(status)} on ${method} of an artifact.`);
    this.name = "ArtifactStorageError";
    this.status = status;
  }
}

/** Stores an artifact's bytes, replacing what was under its path before. */
export async function putArtifactObject(input: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly pathname: string;
  readonly signal?: AbortSignal;
}) {
  const response = await fetch(presignArtifact(input.pathname, "PUT"), {
    body: Buffer.from(input.bytes),
    headers: { "content-type": input.mediaType },
    method: "PUT",
    signal: withTimeout(input.signal),
  });
  await response.body?.cancel();
  if (!response.ok) throw new ArtifactStorageError(response.status, "PUT");
}

/** Removes an artifact's bytes; an object already gone counts as removed. */
export async function deleteArtifactObject(pathname: string) {
  const response = await fetch(presignArtifact(pathname, "DELETE"), {
    method: "DELETE",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) {
    throw new ArtifactStorageError(response.status, "DELETE");
  }
}

/**
 * Opens an artifact's bytes as a stream, or answers that the copy the
 * reader holds (`ifNoneMatch`, an ETag this returned before) is current.
 * Undefined when there is no such object. The caller checks the size and
 * type against the row before trusting the bytes.
 */
export async function openArtifactObject(
  pathname: string,
  options: { readonly ifNoneMatch?: string; readonly signal?: AbortSignal } = {}
) {
  const headers = new Headers();
  if (options.ifNoneMatch !== undefined) {
    headers.set("if-none-match", options.ifNoneMatch);
  }
  const response = await fetch(presignArtifact(pathname, "GET"), {
    headers,
    // A stalled connection must not hold a request or a tool step forever:
    // off Vercel no function limit cuts it. The bound covers the body too,
    // and an artifact is a few megabytes at most.
    signal: withTimeout(options.signal),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.status === 304) {
    // Cloud.ru answers 304 without the ETag: the reader's own is current.
    return {
      etag: response.headers.get("etag") ?? options.ifNoneMatch ?? "",
      status: 304 as const,
    };
  }
  const etag = response.headers.get("etag") ?? "";
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ArtifactStorageError(response.status, "GET");
  }
  return {
    contentType: response.headers.get("content-type"),
    etag,
    size: Number(response.headers.get("content-length") ?? Number.NaN),
    status: 200 as const,
    stream: response.body,
  };
}

function presignArtifact(pathname: string, method: "DELETE" | "GET" | "PUT") {
  return presignStoredObject({
    expiresSeconds: presignSeconds,
    key: `${artifactKeyPrefix}${pathname}`,
    method,
  });
}

function withTimeout(signal: AbortSignal | undefined) {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
