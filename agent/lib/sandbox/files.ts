import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { downloadWithin } from "@agent/lib/inbound-media/download";
import { presignStoredObject } from "@shared/object-storage/s3";
import { applicationOrigin } from "@shared/environment/origin";
import { sandboxFileLinkSignature, sandboxFileLinkValid } from "./keys";

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

/** Characters of a shared file's name, its extension included. */
const maximumNameCharacters = 120;

const fileOwnerSchema = z.object({
  mediaType: z.string().min(1),
  name: z.string().min(1),
  sessionId: z.string().min(1),
  sha256: z.string().regex(/^[a-f\d]{64}$/u),
  size: z.number().int().positive().max(maximumSharedFileBytes),
  workspaceId: z.string().min(1),
});

/**
 * A file name a messenger shows as is: no path, no control characters, at
 * most 120 characters. A long name is cut before its extension, which tells
 * the person's device what opens the file. A name made by this is its own
 * result: the link checks it so.
 */
export function sharedFileName(name: string) {
  const base = name.split(/[\\/]/u).at(-1) ?? "";
  // Cut by code points: a name cut inside a pair would not encode as a URL.
  const clean = Array.from(
    base
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/[^\p{L}\p{N}._ ()-]+/gu, "_")
      .trim()
  );
  const extension =
    clean.length > maximumNameCharacters
      ? (/\.[\p{L}\p{N}]{1,10}$/u.exec(clean.join(""))?.[0] ?? "")
      : "";
  const short = `${clean
    .slice(0, maximumNameCharacters - Array.from(extension).length)
    .join("")
    .trim()}${extension}`;
  return short.length > 0 && short !== "." && short !== ".." ? short : "file";
}

/**
 * A name as RFC 5987 writes it in `filename*`: `encodeURIComponent` leaves
 * `'`, `(`, `)` and `*` as they are, which that grammar does not allow.
 */
function extendedFileName(name: string) {
  return encodeURIComponent(name).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function objectKey(id: string, name: string) {
  return `sandbox/files/${id}/${name}`;
}

/** Stores one file and returns the link the person gets. */
export async function shareSandboxFile(input: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly name: string;
  readonly owner?: { readonly sessionId: string; readonly workspaceId: string };
}) {
  if (input.bytes.byteLength > maximumSharedFileBytes) {
    throw new Error("A shared file may be at most 10 MB.");
  }
  const id = randomBytes(12).toString("hex");
  const name = sharedFileName(input.name);
  const key = objectKey(id, name);
  const response = await fetch(
    presignStoredObject({ expiresSeconds: 300, key, method: "PUT" }),
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
  if (input.owner !== undefined) {
    const owned = await fetch(
      presignStoredObject({
        expiresSeconds: 300,
        key: `sandbox/file-owners/${id}.json`,
        method: "PUT",
      }),
      {
        body: JSON.stringify({
          ...input.owner,
          mediaType: input.mediaType,
          name,
          sha256: createHash("sha256").update(input.bytes).digest("hex"),
          size: input.bytes.byteLength,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
        signal: AbortSignal.timeout(uploadTimeoutMs),
      }
    );
    if (!owned.ok) throw new Error("The file's ownership could not be stored.");
    await owned.body?.cancel();
  }
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
  const key = signedObjectKey(input);
  if (key === undefined) return undefined;
  const { name } = input;
  // Downloaded, never rendered on the storage's origin: an SVG or HTML the
  // task agent made must not run as a page.
  return presignStoredObject({
    expiresSeconds: redirectSeconds,
    key,
    method: "GET",
    responseContentDisposition: `attachment; filename*=UTF-8''${extendedFileName(name)}`,
  });
}

/** The object a link names, when its signature opens it. */
function signedObjectKey(input: {
  readonly id: string;
  readonly name: string;
  readonly signature: string | null;
}) {
  if (!/^[\da-f]{24}$/u.test(input.id) || input.signature === null) {
    return undefined;
  }
  if (sharedFileName(input.name) !== input.name) return undefined;
  const key = objectKey(input.id, input.name);
  return sandboxFileLinkValid(key, input.signature) ? key : undefined;
}

/**
 * Whether a URL is a link {@link shareSandboxFile} made: on Bro's own origin,
 * at a shared file's path, signed for its object. Such a link reaches only
 * Bro and the file the task agent stored, so a channel may fetch it to
 * upload the file, whatever the task agent's report asked for.
 */
export function isSharedFileLink(value: string) {
  const url = URL.parse(value);
  if (url?.protocol !== "https:" || url.username || url.password) return false;
  let origin: string;
  try {
    origin = applicationOrigin();
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  const [id, segment, ...rest] = url.pathname
    .slice(`${sandboxFilesPath}/`.length)
    .split("/");
  if (
    !url.pathname.startsWith(`${sandboxFilesPath}/`) ||
    id === undefined ||
    segment === undefined ||
    rest.length > 0
  ) {
    return false;
  }
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return false;
  }
  return (
    signedObjectKey({ id, name, signature: url.searchParams.get("sig") }) !==
    undefined
  );
}

export async function readOwnedSharedFile(
  value: string,
  owner: { readonly sessionId: string; readonly workspaceId: string }
) {
  if (!isSharedFileLink(value)) return undefined;
  const url = new URL(value);
  const [id, segment] = url.pathname
    .slice(`${sandboxFilesPath}/`.length)
    .split("/");
  if (id === undefined || segment === undefined) return undefined;
  const name = decodeURIComponent(segment);
  const metadata = await fetch(
    presignStoredObject({
      expiresSeconds: 300,
      key: `sandbox/file-owners/${id}.json`,
      method: "GET",
    }),
    { redirect: "error", signal: AbortSignal.timeout(uploadTimeoutMs) }
  );
  if (!metadata.ok) {
    await metadata.body?.cancel();
    return undefined;
  }
  const record = fileOwnerSchema.safeParse(await metadata.json()).data;
  if (
    record === undefined ||
    record.workspaceId !== owner.workspaceId ||
    record.sessionId !== owner.sessionId ||
    record.name !== name
  )
    return undefined;
  const result = await downloadWithin(
    new URL(
      presignStoredObject({
        expiresSeconds: 300,
        key: objectKey(id, name),
        method: "GET",
      })
    ),
    maximumSharedFileBytes,
    { redirect: "error", timeoutMs: uploadTimeoutMs }
  );
  if (
    result.kind !== "bytes" ||
    result.bytes.byteLength !== record.size ||
    createHash("sha256").update(result.bytes).digest("hex") !== record.sha256
  )
    return undefined;
  return {
    bytes: new Uint8Array(result.bytes),
    mediaType: record.mediaType,
    name: record.name,
  };
}
