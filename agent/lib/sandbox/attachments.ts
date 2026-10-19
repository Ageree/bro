import { pathMatchesBytes } from "./inbox";

/**
 * The bytes of the person's files staged in a sandbox, kept in this process
 * (19.10). eve reads every photo and PDF of the history back out of the
 * sandbox before each model call (`hydrateSandboxAttachments`,
 * `harness/attachment-staging.js`), so the first step after the sandbox was
 * stopped (`capacity.ts`, five minutes after a turn) waited 2–6 s for its
 * snapshot to restore, only to read files eve itself had written. A staged
 * file's path names its bytes (`/workspace/attachments/<sha256, 16 hex>/…`),
 * so bytes kept under it never go stale; only bytes that match their path
 * are kept. Process memory: a restart reads each file from the sandbox once
 * more.
 */

const cacheBytes = 128 * 1024 * 1024;
/** A file past this is read from the sandbox each time. */
const maximumFileBytes = 24 * 1024 * 1024;

const files = new Map<string, Uint8Array>();
let keptBytes = 0;

function keyOf(sandboxId: string, path: string) {
  return `${sandboxId}\0${path}`;
}

/** The staged file's bytes, when this process holds them. */
export function keptAttachment(sandboxId: string, path: string) {
  const key = keyOf(sandboxId, path);
  const bytes = files.get(key);
  if (bytes === undefined) return undefined;
  // In order of use, so the file unused longest goes first.
  files.delete(key);
  files.set(key, bytes);
  // A copy: whatever the reader does with its bytes leaves the kept ones.
  return bytes.slice();
}

/** Keeps a staged file's bytes, if they are the file its path names. */
export function keepAttachment(
  sandboxId: string,
  path: string,
  bytes: Uint8Array
) {
  if (bytes.byteLength > maximumFileBytes) return;
  if (!pathMatchesBytes(path, bytes)) return;
  const key = keyOf(sandboxId, path);
  const known = files.get(key);
  if (known !== undefined) {
    files.delete(key);
    keptBytes -= known.byteLength;
  }
  files.set(key, bytes.slice());
  keptBytes += bytes.byteLength;
  for (const [oldest, old] of files) {
    if (keptBytes <= cacheBytes) break;
    files.delete(oldest);
    keptBytes -= old.byteLength;
  }
}

/** Forgets the files kept under `path` of the sandbox, or all of its own. */
export function forgetAttachments(sandboxId: string, path = "") {
  const prefix = keyOf(sandboxId, path);
  for (const [key, bytes] of files) {
    if (!key.startsWith(prefix)) continue;
    files.delete(key);
    keptBytes -= bytes.byteLength;
  }
}
