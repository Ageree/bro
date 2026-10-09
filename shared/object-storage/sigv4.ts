import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 in the query string, for any S3-compatible Object
 * Storage (Cloud.ru, Selectel). Nothing here reads the environment, so a
 * script run by plain Node (`scripts/cloudru-app-host/blob-to-s3.ts`) signs
 * the same way Bro does; which endpoint, region and key to sign with is
 * `objectStore()` in `@shared/object-storage/s3`.
 */

/** Cloud.ru's Object Storage, what Bro signs for when `S3_*` are not set. */
export const cloudruObjectStorage = {
  endpoint: "https://s3.cloud.ru",
  region: "ru-central-1",
} as const;
/** SigV4 refuses a presigned URL meant to live longer than a week. */
const maximumExpirySeconds = 7 * 24 * 60 * 60;

type S3Method = "DELETE" | "GET" | "HEAD" | "PUT";

/**
 * A presigned URL: `url` with `X-Amz-*` query parameters that let whoever
 * holds it send `method` to that very URL until `expiresSeconds` after
 * `now`. Only the `host` header is signed and the payload is not
 * (`UNSIGNED-PAYLOAD`), so a host can stream a chunk with any client and
 * a reader may add conditional headers. The path of `url` must already be
 * encoded as it will be sent; query parameters it carries are signed too.
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
 * RFC 3986 encoding as SigV4 wants it: everything but letters, digits and
 * `-._~` percent-encoded, spaces too.
 */
export function uriEncode(value: string) {
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
