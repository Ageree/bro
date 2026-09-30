import { createHash, createHmac } from "node:crypto";
import { env } from "@shared/environment";

/**
 * Object Storage of the browser pool (Cloud.ru S3, `ru-central-1`): parked
 * sandboxes, the host code bundle and the sandbox root file system, all in
 * BROWSER_STATE_BUCKET. The key stays in Bro. A host gets presigned URLs
 * (AWS Signature Version 4 in the query string), each good for one method
 * on one object for a while, so nothing on a VM can reach another object.
 * Bro's own listing and deletion go through the same presigned URLs.
 */
const endpoint = "https://s3.cloud.ru";
const region = "ru-central-1";
const requestTimeoutMs = 30_000;
/** SigV4 refuses a presigned URL meant to live longer than a week. */
const maximumExpirySeconds = 7 * 24 * 60 * 60;
/** Deletions sent at once when a prefix goes. */
const parallelDeletes = 8;

type S3Method = "DELETE" | "GET" | "PUT";

/** A reply of Object Storage that was not a 2xx. */
export class BrowserStateStoreError extends Error {
  readonly status: number;

  constructor(status: number, method: S3Method, body: string) {
    super(
      `Object Storage ${String(status)} on ${method}: ${body.slice(0, 300)}`
    );
    this.name = "BrowserStateStoreError";
    this.status = status;
  }
}

/**
 * A presigned URL: `url` with `X-Amz-*` query parameters that let whoever
 * holds it send `method` to that very URL until `expiresSeconds` after
 * `now`. Only the `host` header is signed and the payload is not
 * (`UNSIGNED-PAYLOAD`), so a host can stream a chunk with any client. The
 * path of `url` must already be encoded as it will be sent; query
 * parameters it carries are signed too.
 */
export function presignS3Url(input: {
  readonly accessKeyId: string;
  readonly expiresSeconds: number;
  readonly method: S3Method;
  readonly now: Date;
  readonly region: string;
  readonly secretAccessKey: string;
  readonly url: string;
}) {
  if (
    !Number.isInteger(input.expiresSeconds) ||
    input.expiresSeconds < 1 ||
    input.expiresSeconds > maximumExpirySeconds
  ) {
    throw new Error("A presigned URL lives 1 second to 7 days.");
  }
  const url = new URL(input.url);
  const amzDate = input.now
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const parameters: [string, string][] = [
    ...url.searchParams.entries(),
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(input.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const query = parameters
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .toSorted(([nameA, valueA], [nameB, valueB]) =>
      nameA === nameB ? compare(valueA, valueB) : compare(nameA, nameB)
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    url.pathname,
    query,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  let key = hmac(`AWS4${input.secretAccessKey}`, day);
  for (const part of [input.region, "s3", "aws4_request"]) {
    key = hmac(key, part);
  }
  const signature = createHmac("sha256", key)
    .update(stringToSign)
    .digest("hex");
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`;
}

/**
 * A presigned URL for one object of the pool's bucket, by its key
 * (`sets/<sandbox>/<generation>/chunk-0000`, say).
 */
export function presignBrowserStateObject(input: {
  readonly expiresSeconds: number;
  readonly key: string;
  readonly method: S3Method;
  readonly now?: Date;
}) {
  const store = stateStore();
  return presignS3Url({
    ...store.credentials,
    expiresSeconds: input.expiresSeconds,
    method: input.method,
    now: input.now ?? new Date(),
    region,
    url: `${endpoint}/${uriEncode(store.bucket)}/${input.key
      .split("/")
      .map((segment) => uriEncode(segment))
      .join("/")}`,
  });
}

/** The keys of the bucket's objects under `prefix`, every page of them. */
export async function listBrowserStateObjects(prefix: string) {
  const store = stateStore();
  const keys: string[] = [];
  let continuation: string | undefined;
  do {
    const listing = new URL(`${endpoint}/${uriEncode(store.bucket)}`);
    listing.searchParams.set("list-type", "2");
    listing.searchParams.set("prefix", prefix);
    if (continuation !== undefined) {
      listing.searchParams.set("continuation-token", continuation);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the previous page's continuation token.
    const text = await send(
      "GET",
      presignS3Url({
        ...store.credentials,
        expiresSeconds: 300,
        method: "GET",
        now: new Date(),
        region,
        url: listing.toString(),
      })
    );
    keys.push(...xmlValues(text, "Key"));
    continuation =
      xmlValues(text, "IsTruncated")[0] === "true"
        ? xmlValues(text, "NextContinuationToken")[0]
        : undefined;
  } while (continuation !== undefined);
  return keys;
}

/** The text of one object of the bucket, or undefined when there is none. */
export async function readBrowserStateObject(key: string) {
  try {
    return await send(
      "GET",
      presignBrowserStateObject({ expiresSeconds: 300, key, method: "GET" })
    );
  } catch (error) {
    if (error instanceof BrowserStateStoreError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The bytes of one object of the bucket, exactly as stored: a file whose
 * checksum is checked must not pass through a text decoder. A missing
 * object throws `BrowserStateStoreError` with 404, like any other refusal.
 */
export async function readBrowserStateObjectBytes(key: string) {
  const response = await fetch(
    presignBrowserStateObject({ expiresSeconds: 300, key, method: "GET" }),
    { signal: AbortSignal.timeout(requestTimeoutMs) }
  );
  if (!response.ok) {
    throw new BrowserStateStoreError(
      response.status,
      "GET",
      await response.text()
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Delete every object under `prefix` — a workspace's sets when it is
 * deleted (`sets/<sandbox>/`), or a set a newer one replaced. An object
 * already gone counts as deleted. How many were listed.
 */
export async function deleteBrowserStateObjects(prefix: string) {
  if (!prefix.endsWith("/")) {
    throw new Error("A prefix to delete ends with a slash.");
  }
  const keys = await listBrowserStateObjects(prefix);
  for (let start = 0; start < keys.length; start += parallelDeletes) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- A few deletions at a time, not thousands at once.
    await Promise.all(
      keys.slice(start, start + parallelDeletes).map(async (key) => {
        try {
          await send(
            "DELETE",
            presignBrowserStateObject({
              expiresSeconds: 300,
              key,
              method: "DELETE",
            })
          );
        } catch (error) {
          if (error instanceof BrowserStateStoreError && error.status === 404) {
            return;
          }
          throw error;
        }
      })
    );
  }
  return keys.length;
}

function stateStore() {
  const tenant = env.CLOUDRU_S3_TENANT_ID;
  const keyId = env.CLOUDRU_KEY_ID;
  const secret = env.CLOUDRU_KEY_SECRET;
  const bucket = env.BROWSER_STATE_BUCKET;
  if (
    tenant === undefined ||
    keyId === undefined ||
    secret === undefined ||
    bucket === undefined
  ) {
    throw new Error(
      "CLOUDRU_S3_TENANT_ID, CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET and BROWSER_STATE_BUCKET are not configured."
    );
  }
  // Cloud.ru's S3 key is the tenant and the access key id together.
  return {
    bucket,
    credentials: { accessKeyId: `${tenant}:${keyId}`, secretAccessKey: secret },
  };
}

async function send(method: S3Method, url: string) {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await response.text();
  if (!response.ok)
    throw new BrowserStateStoreError(response.status, method, text);
  return text;
}

/**
 * RFC 3986 encoding as SigV4 wants it: everything but letters, digits and
 * `-._~` percent-encoded, spaces too.
 */
function uriEncode(value: string) {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/gu,
    (character) =>
      `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ""}`
  );
}

function compare(a: string, b: string) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function hmac(key: Buffer | string, data: string) {
  return createHmac("sha256", key).update(data).digest();
}

/** The text of every `<name>` element: the listing is flat and small. */
function xmlValues(xml: string, name: string) {
  return [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "gu"))].map(
    (match) => decodeXml(match[1] ?? "")
  );
}

const xmlEntities = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);

function decodeXml(text: string) {
  return text.replaceAll(
    /&(#x?[\da-f]+|[a-z]+);/giu,
    (entity, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      }
      if (body.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      }
      return xmlEntities.get(body.toLowerCase()) ?? entity;
    }
  );
}
