import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { documentByteCap } from "@agent/lib/inbound-media/media-type";
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

/** The cap of a document the person sends, so any of them can go. */
export const attachmentByteCap = documentByteCap;
/** The files one message to the task agent brings along. */
export const attachmentsPerMessage = 10;

/**
 * Where eve's staging puts a file, its name as `safeFilename` leaves it:
 * that name is never longer than the person's own, and a file name on the
 * sandbox's disk is at most 255 bytes.
 */
const attachmentPath =
  /^\/workspace\/attachments\/([\da-f]{16})\/([\w.-]{1,255})$/u;
/**
 * The same path inside Bro's text, not part of a longer path or name: a
 * longer name, a deeper path, a path under another root or a name running
 * on into other letters or a NUL matches nothing. A few characters more
 * than a name holds leave room for a sentence's period.
 */
const attachmentPathInText =
  /(?<![\w./\p{L}\p{N}-])\/workspace\/attachments\/[\da-f]{16}\/[\w.-]{1,263}(?![\w./\0\p{L}\p{N}-])/gu;
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

/**
 * How long a stored file stays good to take. Bro's hook stores the file
 * anew whenever the person's turn names it to `task` (`putInbox` always
 * writes, so the object's Last-Modified is that turn's), and the task agent
 * takes it within seconds; an older object is one a later turn that was not
 * the person's (a page, a report) named again, and it is refused.
 */
export const inboxFreshMs = 5 * 60_000;

/**
 * One file as the task agent may take it: there, stored within
 * {@link inboxFreshMs} (an object whose date is missing or unreadable counts
 * as old), or neither. An old object's body is not read.
 */
export async function getInbox(
  key: string,
  signal?: AbortSignal
): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "stale" }
  | { readonly bytes: Uint8Array; readonly kind: "file" }
> {
  const response = await request(key, "GET", {}, signal);
  if (response.status === 404) {
    // Cloud.ru answers 404 for a missing bucket too: only NoSuchKey is a
    // file nobody stored.
    if ((await response.text()).includes("NoSuchBucket")) {
      throw new InboxStorageError("Object Storage has no such bucket.");
    }
    return { kind: "missing" };
  }
  if (!storedFresh(response)) {
    await response.body?.cancel();
    return { kind: "stale" };
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
  return { bytes, kind: "file" };
}

/** Whether an object's Last-Modified is within {@link inboxFreshMs}. */
function storedFresh(response: Response) {
  const storedAt = Date.parse(response.headers.get("last-modified") ?? "");
  return Number.isFinite(storedAt) && Date.now() - storedAt <= inboxFreshMs;
}

/**
 * The object that says a sandbox holds the person's files. It lives
 * outside `sandbox/inbox/`, which a sweep may empty, and is never removed:
 * the files stay in the sandbox's `/workspace` and its snapshots. The id is
 * a code sandbox's, as `sandboxd` takes it (`sandboxIdFor`).
 */
function personFilesMarkerKey(sandboxId: string) {
  if (!/^[\da-z-]{1,63}$/u.test(sandboxId)) {
    throw new InboxStorageError("Only a code sandbox's id can be marked.");
  }
  return `sandbox/person-files/${sandboxId}`;
}

/**
 * The object that says some task agent of one conversation was given the
 * person's files: its report may carry their content back into the
 * conversation, so a task agent the conversation starts later keeps off the
 * web unless the person's own turn sent it (`personCallKey`). Hashed like
 * the inbox, and never removed either.
 */
function conversationMarkerKey(workspaceId: string, parentSessionId: string) {
  return [
    "sandbox/person-files-conversations",
    sha256(workspaceId).slice(0, 16),
    sha256(parentSessionId).slice(0, 16),
  ].join("/");
}

/**
 * The object that says the person's own turn made one `task` call: Bro's
 * hook stores it as the call streams in, before eve starts the task agent
 * (`agent/hooks/task-files.ts`), and the task agent that call started
 * checks it (`ctx.session.parent.callId`). Good for {@link inboxFreshMs},
 * like a file.
 */
function personCallKey(
  workspaceId: string,
  parentSessionId: string,
  callId: string
) {
  return [
    "sandbox/inbox",
    sha256(workspaceId).slice(0, 16),
    sha256(parentSessionId).slice(0, 16),
    "calls",
    sha256(callId).slice(0, 32),
  ].join("/");
}

async function putMark(key: string, signal: AbortSignal | undefined) {
  const response = await request(
    key,
    "PUT",
    { body: "1", headers: { "content-type": "text/plain" } },
    signal
  );
  await response.body?.cancel();
}

/**
 * Whether the object is there, and when `fresh`, stored within
 * {@link inboxFreshMs}. Only Object Storage's own "no such key" reads as
 * absent; any other answer or an outage throws.
 */
async function markHeld(
  key: string,
  signal: AbortSignal | undefined,
  options: { readonly fresh?: boolean } = {}
) {
  const response = await request(key, "GET", {}, signal);
  if (response.status !== 404) {
    await response.body?.cancel();
    return options.fresh === true ? storedFresh(response) : true;
  }
  if ((await response.text()).includes("NoSuchKey")) return false;
  throw new InboxStorageError(
    "Object Storage did not say whether a mark of the person's files is there."
  );
}

/**
 * Marks the sandbox, and its conversation, as holding the person's files,
 * before the first of them goes in: from then on the tool router keeps that
 * sandbox off the network (`sandboxHoldsPersonFiles` in `./router.ts`), and
 * the conversation's later task agents follow unless the person sent them
 * (`conversationHoldsPersonFiles`). The conversation goes first; a failure
 * throws, and the task agent's hook then copies nothing.
 */
export async function markSandboxHoldsPersonFiles(
  target: {
    readonly parentSessionId: string;
    readonly sandboxId: string;
    readonly workspaceId: string;
  },
  signal?: AbortSignal
) {
  const sandboxKey = personFilesMarkerKey(target.sandboxId);
  await putMark(
    conversationMarkerKey(target.workspaceId, target.parentSessionId),
    signal
  );
  await putMark(sandboxKey, signal);
}

/**
 * Whether the sandbox was ever given the person's files, or told to keep off
 * the web as if it was. Only Object Storage's own "no such key" reads as no;
 * any other answer, an outage or a malformed id throws, and the router then
 * refuses as if it were yes.
 */
export async function sandboxHoldsPersonFiles(
  sandboxId: string,
  signal?: AbortSignal
) {
  return await markHeld(personFilesMarkerKey(sandboxId), signal);
}

/** Whether some task agent of the conversation was given the person's files. */
export async function conversationHoldsPersonFiles(
  workspaceId: string,
  parentSessionId: string,
  signal?: AbortSignal
) {
  return await markHeld(
    conversationMarkerKey(workspaceId, parentSessionId),
    signal
  );
}

/** Records that the person's own turn made this `task` call. */
export async function putPersonCall(
  workspaceId: string,
  parentSessionId: string,
  callId: string,
  signal?: AbortSignal
) {
  await putMark(personCallKey(workspaceId, parentSessionId, callId), signal);
}

/** Whether the person's own turn made this `task` call just now. */
export async function personCallFresh(
  workspaceId: string,
  parentSessionId: string,
  callId: string,
  signal?: AbortSignal
) {
  return await markHeld(
    personCallKey(workspaceId, parentSessionId, callId),
    signal,
    { fresh: true }
  );
}

/**
 * Whether the sandbox has a file at the path, without reading it: a file the
 * task agent wrote there may be far larger than any the person sent.
 */
export async function sandboxHasFile(
  sandbox: Pick<SandboxSession, "readFile">,
  path: string,
  signal?: AbortSignal
) {
  const stream = await sandbox.readFile({ abortSignal: signal, path });
  if (stream === null) return false;
  await stream.cancel().catch(() => undefined);
  return true;
}

/**
 * A sandbox file's bytes up to {@link attachmentByteCap}: null when there is
 * none, "oversize" as soon as more arrived than that, the rest unread.
 */
export async function readSandboxFileWithin(
  sandbox: Pick<SandboxSession, "readFile">,
  path: string,
  signal?: AbortSignal
) {
  const stream = await sandbox.readFile({ abortSignal: signal, path });
  if (stream === null) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The file arrives as a sequence of chunks.
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > attachmentByteCap) break;
    chunks.push(value);
  }
  if (total > attachmentByteCap) {
    await reader.cancel().catch(() => undefined);
    return "oversize" as const;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
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
      await pause(signal);
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
    await pause(signal);
  }
}

/**
 * The wait before the second try. The caller's deadline cuts it short and
 * fails the request at once.
 */
async function pause(signal: AbortSignal | undefined) {
  // An abort that came before the wait fires no event.
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, retryDelayMs);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
  signal?.throwIfAborted();
}

function bounded(signal: AbortSignal | undefined) {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}
