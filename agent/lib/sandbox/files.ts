import { randomBytes, timingSafeEqual } from "node:crypto";
import { presignBrowserStateObject } from "@agent/lib/browser-pool/s3";
import { applicationOrigin } from "@shared/environment/origin";
import { sandboxFileLinkSignature } from "./keys";

/**
 * Files the task agent made, handed to the person: the bytes go to Object
 * Storage on Cloud.ru, and the link is Bro's own (`/eve/v1/sandbox-files/…`)
 * with a signature that opens that one object. The link redirects to a
 * fresh presigned URL, so it outlives the seven days such a URL may live.
 */

export const sandboxFilesPath = "/eve/v1/sandbox-files";
/** The same cap as a message attachment: Telegram refuses a larger photo. */
export const maximumSharedFileBytes = 10 * 1024 * 1024;
const uploadTimeoutMs = 60_000;
/** The redirect's own link lives just long enough to be followed. */
const redirectSeconds = 10 * 60;

/** A file name a messenger shows as is: no path, no control characters. */
export function sharedFileName(name: string) {
  const base = name.split(/[\\/]/u).at(-1) ?? "";
  const clean = base
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[^\p{L}\p{N}._ ()-]+/gu, "_")
    .trim()
    .slice(0, 120);
  return clean.length > 0 && clean !== "." && clean !== ".." ? clean : "file";
}

function objectKey(id: string, name: string) {
  return `sandbox/files/${id}/${name}`;
}

/** Stores one file and returns the link the person gets. */
export async function shareSandboxFile(input: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly name: string;
}) {
  if (input.bytes.byteLength > maximumSharedFileBytes) {
    throw new Error("A shared file may be at most 10 MB.");
  }
  const id = randomBytes(12).toString("hex");
  const name = sharedFileName(input.name);
  const key = objectKey(id, name);
  const response = await fetch(
    presignBrowserStateObject({ expiresSeconds: 300, key, method: "PUT" }),
    {
      body: Buffer.from(input.bytes),
      headers: { "content-type": input.mediaType },
      method: "PUT",
      signal: AbortSignal.timeout(uploadTimeoutMs),
    }
  );
  if (!response.ok) {
    throw new Error(
      `The file could not be stored (Object Storage ${String(response.status)}).`
    );
  }
  await response.body?.cancel();
  const url = new URL(
    `${sandboxFilesPath}/${id}/${encodeURIComponent(name)}`,
    applicationOrigin()
  );
  url.searchParams.set("sig", sandboxFileLinkSignature(key));
  return {
    bytes: input.bytes.byteLength,
    mediaType: input.mediaType,
    name,
    url: url.href,
  };
}

/**
 * Where a shared file's link leads: a presigned URL of its object, or
 * undefined when the signature does not open it.
 */
export function sharedFileLocation(input: {
  readonly id: string;
  readonly name: string;
  readonly signature: string | null;
}) {
  if (!/^[\da-f]{24}$/u.test(input.id) || input.signature === null) {
    return undefined;
  }
  const name = sharedFileName(input.name);
  if (name !== input.name) return undefined;
  const key = objectKey(input.id, name);
  const expected = Buffer.from(sandboxFileLinkSignature(key));
  const given = Buffer.from(input.signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }
  // Downloaded, never rendered on the storage's origin: an SVG or HTML the
  // task agent made must not run as a page.
  return presignBrowserStateObject({
    expiresSeconds: redirectSeconds,
    key,
    method: "GET",
    responseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
}
