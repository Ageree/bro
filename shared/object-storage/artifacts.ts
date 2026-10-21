import { Agent } from "undici";
import * as z from "zod";
import {
  objectStorageConfigured,
  presignStoredObject,
} from "@shared/object-storage/s3";
import {
  objectRequestTimeoutMs,
  uploadTimeoutMs,
} from "@shared/object-storage/upload-timeout";

/**
 * The bytes behind `/artifacts/<id>`: images Bro captured, generated or was
 * sent, and files copied from Gmail and Drive. Each lives in Object Storage
 * under `artifacts/` plus the `storage_pathname` its row records, so the
 * rows written while the files lived in Vercel Blob still name them
 * (`scripts/cloudru-app-host/blob-to-s3.ts` copied them under the same key).
 */
const artifactKeyPrefix = "artifacts/";
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

/**
 * How an upload dials the store. TCP and TLS take 40 ms from the VM, yet some
 * connections hang, and the one that hung cost the whole of its bound: 19.10
 * a fresh process's connect ended «AggregateError [ETIMEDOUT]» at Node's
 * 250 ms per address; 21.10 three report screenshots took 10.3 s, undici's
 * own 10 s bound for a connection plus the 0.3 s the next socket needed.
 * So the first tries give a connection a second and a bit to come up, past
 * the first retransmit of a lost SYN (1 s) and far short of 10 s (undici
 * checks its bound twice a second: 1.5 s in effect), and then go on to a fresh
 * socket; only the last waits out a slow one, as Node's 250 ms also dropped a
 * handshake that was merely slow.
 */
const quickConnectMs = 1200;
const quickTries = 3;
const patientAttemptMs = 2500;
let quickDialer: Agent | undefined;
let patientDialer: Agent | undefined;

/** The `fetch` option that makes the connection the quick way or the patient one. */
function dialing(quick: boolean) {
  if (quick) {
    quickDialer ??= new Agent({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: quickConnectMs,
      connect: { timeout: quickConnectMs },
    });
    return { dispatcher: quickDialer };
  }
  patientDialer ??= new Agent({
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: patientAttemptMs,
  });
  return { dispatcher: patientDialer };
}

/** A picture or a page that takes the store longer than this is logged. */
const smallUploadBytes = 1024 * 1024;
const slowSmallUploadMs = 1500;
/** The code undici or Node gave a failed connection (`UND_ERR_CONNECT_TIMEOUT`). */
const connectionFailureSchema = z.object({
  cause: z.object({ code: z.string() }).optional(),
});

/** Stores an artifact's bytes, replacing what was under its path before. */
export async function putArtifactObject(input: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly pathname: string;
  readonly signal?: AbortSignal;
}) {
  const upload = (quick: boolean) =>
    fetch(presignArtifact(input.pathname, "PUT"), {
      ...dialing(quick),
      body: Buffer.from(input.bytes),
      headers: { "content-type": input.mediaType },
      method: "PUT",
      // An upload of a 10 MB attachment takes longer than a read's bound.
      signal: withTimeout(
        input.signal,
        uploadTimeoutMs(input.bytes.byteLength)
      ),
    });
  // A connection that failed («fetch failed», a TypeError) is tried again on
  // a fresh socket: the same bytes under the same key change nothing. A
  // timeout or a refusal is not. The tries that failed are logged: the
  // retry would otherwise hide what the store does to a connection.
  const startedAt = performance.now();
  const failures: string[] = [];
  let response: Response | undefined;
  try {
    for (let attempt = 1; response === undefined; attempt += 1) {
      const quick = attempt <= quickTries;
      const attemptStartedAt = performance.now();
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- A try starts only once the one before has failed.
        response = await upload(quick);
      } catch (error) {
        if (
          !(error instanceof TypeError) ||
          !quick ||
          input.signal?.aborted === true
        ) {
          throw error;
        }
        const code =
          connectionFailureSchema.safeParse(error).data?.cause?.code ??
          "unknown";
        failures.push(
          `${code} after ${String(Math.round(performance.now() - attemptStartedAt))} ms`
        );
      }
    }
  } finally {
    const ms = Math.round(performance.now() - startedAt);
    if (
      failures.length > 0 ||
      (input.bytes.byteLength < smallUploadBytes && ms > slowSmallUploadMs)
    ) {
      console.warn("[object-storage] slow upload", {
        bytes: input.bytes.byteLength,
        failures,
        ms,
      });
    }
  }
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
    signal: AbortSignal.timeout(objectRequestTimeoutMs),
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
  }, objectRequestTimeoutMs);
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
