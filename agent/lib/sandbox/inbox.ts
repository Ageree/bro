import { createHash } from "node:crypto";
import { presignStoredObject } from "@shared/object-storage/s3";

/**
 * The person's files on their way from Bro's sandbox to the task agent's
 * (docs/roadmap.md, item 30). eve stages a file the person sent at
 * `/workspace/attachments/<sha256 of its bytes, 16 hex>/<safe name>` in Bro's
 * sandbox (`harness/attachment-staging.js`), but the task agent runs in a
 * sandbox of its own: when Bro names such a path to `task`, Bro's hook
 * copies the bytes to Object Storage (`agent/hooks/task-files.ts`), and the
 * task agent's hook puts them at the same path in its sandbox
 * (`agent/subagents/task/hooks/person-files.ts`). The path's hash names the
 * bytes, so each side checks the file it moves against it.
 */

/** The same cap as a document the person sends (`documentByteCap`). */
export const attachmentByteCap = 10 * 1024 * 1024;
/** The files one message to the task agent brings along. */
export const attachmentsPerMessage = 10;

/** Where eve's staging puts a file, its name as `safeFilename` leaves it. */
const attachmentPath =
  /^\/workspace\/attachments\/([\da-f]{16})\/([\w.-]{1,120})$/u;
/**
 * The same path inside Bro's text, not part of a longer path or name: a
 * longer name, a deeper path, a path under another root or a name running
 * on into other letters or a NUL matches nothing. A few characters more
 * than a name holds leave room for a sentence's period.
 */
const attachmentPathInText =
  /(?<![\w./-])\/workspace\/attachments\/[\da-f]{16}\/[\w.-]{1,128}(?![\w./\0\p{L}\p{N}-])/gu;
/** How many distinct paths one text is searched for. */
const scannedPaths = 50;
/** A presigned URL here is used at once, by the server that signed it. */
const presignSeconds = 300;
/** One request to Object Storage, its body included. */
const requestTimeoutMs = 15_000;
const retryDelayMs = 1000;

/** The path's hash and name, or undefined when it is not a staged file. */
function parseAttachmentPath(path: string) {
  const match = attachmentPath.exec(path);
  const [, hash, name] = match ?? [];
  if (hash === undefined || name === undefined) return undefined;
  // A name of dots only would climb out of its directory.
  if (/^\.+$/u.test(name)) return undefined;
  return { hash, name };
}

/**
 * The staged files a text names, each once, in the order it names them.
 * A path that ends a sentence keeps its period out: eve's names seldom end
 * with one, and such a file is simply not found.
 */
export function namedAttachmentPaths(text: string) {
  const paths = new Set<string>();
  for (const [match] of text.matchAll(attachmentPathInText)) {
    const path = match.replace(/\.+$/u, "");
    if (parseAttachmentPath(path) !== undefined) paths.add(path);
    if (paths.size >= scannedPaths) break;
  }
  return [...paths];
}

/** Whether the bytes are the file the path names: its hash says so. */
export function pathMatchesBytes(path: string, bytes: Uint8Array) {
  const parsed = parseAttachmentPath(path);
  return parsed !== undefined && sha256(bytes).slice(0, 16) === parsed.hash;
}

/**
 * The object one file waits in for the task agents of one conversation of
 * one workspace: `sandbox/inbox/<workspace>/<session>/<hash>/<name>`, the
 * first two hashed so a listing shows no ids. The task agent reads only
 * under its own workspace and its parent's session.
 */
export function inboxKey(
  workspaceId: string,
  parentSessionId: string,
  path: string
) {
  const parsed = parseAttachmentPath(path);
  if (parsed === undefined) {
    throw new Error("Only a staged attachment's path has an inbox key.");
  }
  return [
    "sandbox/inbox",
    sha256(workspaceId).slice(0, 16),
    sha256(parentSessionId).slice(0, 16),
    parsed.hash,
    parsed.name,
  ].join("/");
}

/** A refusal or an outage of Object Storage while moving a file. */
export class InboxStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxStorageError";
  }
}

/** Stores one file under its key; a replay writes the same object again. */
export async function putInbox(
  key: string,
  bytes: Uint8Array,
  signal?: AbortSignal
) {
  if (bytes.byteLength > attachmentByteCap) {
    throw new InboxStorageError("A file in the inbox may be at most 10 MB.");
  }
  const response = await request(
    key,
    "PUT",
    {
      body: Buffer.from(bytes),
      headers: { "content-type": "application/octet-stream" },
    },
    signal
  );
  await response.body?.cancel();
}

/** One file's bytes, or null when nobody stored them under the key. */
export async function getInbox(key: string, signal?: AbortSignal) {
  const response = await request(key, "GET", {}, signal);
  if (response.status === 404) {
    // Cloud.ru answers 404 for a missing bucket too: only NoSuchKey is a
    // file nobody stored.
    if ((await response.text()).includes("NoSuchBucket")) {
      throw new InboxStorageError("Object Storage has no such bucket.");
    }
    return null;
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > attachmentByteCap) {
    await response.body?.cancel();
    throw new InboxStorageError("The file in the inbox is over 10 MB.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > attachmentByteCap) {
    throw new InboxStorageError("The file in the inbox is over 10 MB.");
  }
  return bytes;
}

/**
 * One request, tried again once a second later when Object Storage failed
 * (5xx) or the connection did; a refusal, a missing object or the caller's
 * own deadline is final. A GET's 404 comes back to the caller.
 */
async function request(
  key: string,
  method: "GET" | "PUT",
  init: Pick<RequestInit, "body" | "headers">,
  signal: AbortSignal | undefined
) {
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt > 0;
    let response: Response;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The retry follows the first attempt.
      response = await fetch(
        presignStoredObject({ expiresSeconds: presignSeconds, key, method }),
        { ...init, method, signal: bounded(signal) }
      );
    } catch (error) {
      if (last || signal?.aborted === true) throw error;
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await pause();
      continue;
    }
    if (response.ok || (method === "GET" && response.status === 404)) {
      return response;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await response.body?.cancel();
    if (last || response.status < 500) {
      throw new InboxStorageError(
        `Object Storage ${String(response.status)} on ${method} of an inbox file.`
      );
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await pause();
  }
}

/** The wait before the second try: past the caller's deadline, it fails at once. */
async function pause() {
  await new Promise((resolve) => {
    setTimeout(resolve, retryDelayMs);
  });
}

function bounded(signal: AbortSignal | undefined) {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}
