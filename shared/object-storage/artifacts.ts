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
/** The slowest upload a PUT waits out: 10 MB in under four minutes. */
const slowestUploadBytesPerSecond = 64 * 1024;
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

  constructor(status: number, method: string, body = "") {
    // The S3 error XML names the cause (`SignatureDoesNotMatch`,
    // `NoSuchBucket`, `EntityTooLarge`) and the request id.
    super(
      `Object Storage ${String(status)} on ${method} of an artifact${body ? `: ${body.slice(0, 300)}` : "."}`
    );
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
    // An upload of a 10 MB attachment takes longer than a read's bound.
    signal: withTimeout(
      input.signal,
      requestTimeoutMs +
        Math.ceil(input.bytes.byteLength / slowestUploadBytesPerSecond) * 1000
    ),
  });
  if (!response.ok) {
    throw new ArtifactStorageError(
      response.status,
      "PUT",
      await response.text()
    );
  }
  await response.body?.cancel();
}

/** Removes an artifact's bytes; an object already gone counts as removed. */
export async function deleteArtifactObject(pathname: string) {
  const response = await fetch(presignArtifact(pathname, "DELETE"), {
    method: "DELETE",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  const body = await response.text();
  if (!isMissingKey(response.status, body)) {
    throw new ArtifactStorageError(response.status, "DELETE", body);
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
  // A stalled connection must not hold a request or a tool step forever:
  // off Vercel no function limit cuts it. The bound is on the answer and on
  // each read of the body after it, not on the whole body: a reader that
  // takes its time over a 10 MB attachment slows the reads, it does not
  // stall Object Storage.
  const stalled = new AbortController();
  const signal =
    options.signal === undefined
      ? stalled.signal
      : AbortSignal.any([options.signal, stalled.signal]);
  const response = await withinBound(stalled, () =>
    fetch(presignArtifact(pathname, "GET"), { headers, signal })
  );
  if (response.status === 304) {
    // Cloud.ru answers 304 without the ETag: the reader's own is current.
    return {
      etag: response.headers.get("etag") ?? options.ifNoneMatch ?? "",
      status: 304 as const,
    };
  }
  if (!response.ok || !response.body) {
    const body = await withinBound(stalled, () => response.text());
    // Only a missing key is a missing artifact: a missing bucket is a 404
    // too, and that is an outage.
    if (isMissingKey(response.status, body)) return undefined;
    throw new ArtifactStorageError(response.status, "GET", body);
  }
  return {
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag") ?? "",
    size: Number(response.headers.get("content-length") ?? Number.NaN),
    status: 200 as const,
    stream: boundedReads(response.body, stalled),
  };
}

function isMissingKey(status: number, body: string) {
  return status === 404 && body.includes("<Code>NoSuchKey</Code>");
}

/**
 * The body, each read of it bounded: a read Object Storage does not answer
 * in time aborts the request, and the stream errors instead of ending
 * short. Reads happen only as fast as the consumer pulls.
 */
function boundedReads(
  body: ReadableStream<Uint8Array>,
  stalled: AbortController
) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await withinBound(stalled, () => reader.read());
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}

/** Runs `step`, aborting the request when it takes longer than the bound. */
async function withinBound<T>(
  stalled: AbortController,
  step: () => Promise<T>
) {
  const timer = setTimeout(() => {
    stalled.abort(
      new DOMException("Object Storage did not answer in time.", "TimeoutError")
    );
  }, requestTimeoutMs);
  try {
    return await step();
  } finally {
    clearTimeout(timer);
  }
}

function presignArtifact(pathname: string, method: "DELETE" | "GET" | "PUT") {
  return presignStoredObject({
    expiresSeconds: presignSeconds,
    key: `${artifactKeyPrefix}${pathname}`,
    method,
  });
}

function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
