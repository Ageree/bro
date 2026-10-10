import { env } from "@shared/environment";
import {
  cloudruObjectStorage,
  presignS3Url,
  uriEncode,
} from "@shared/object-storage/sigv4";

/**
 * Bro's bucket in S3-compatible Object Storage (Cloud.ru, `ru-central-1`, or
 * the provider the `S3_*` settings name, Selectel's `ru-1`),
 * BROWSER_STATE_BUCKET: parked browser sandboxes, host bundles, files the
 * task agent shares and the person's images and attachments. The key stays
 * in Bro. Every request goes through a presigned URL (AWS Signature
 * Version 4 in the query string), good for one method on one object for a
 * while, so a host given one cannot reach another object.
 *
 * This is a presigned URL for one object of the bucket, by its key
 * (`sets/<sandbox>/<generation>/chunk-0000`, say).
 */
export function presignStoredObject(input: {
  readonly expiresSeconds: number;
  readonly key: string;
  readonly method: Parameters<typeof presignS3Url>[0]["method"];
  readonly now?: Date;
  /** The `Content-Disposition` a GET answers with, signed into the URL. */
  readonly responseContentDisposition?: string;
}) {
  const store = objectStore();
  const segments = input.key.split("/");
  // URL parsing folds `.` and `..` away (`a/../b` signs `/b`), so such a key
  // would reach another object. Bro never writes one.
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("An object key must not have a . or .. segment.");
  }
  const url = new URL(
    `${store.endpoint}/${uriEncode(store.bucket)}/${segments
      .map((segment) => uriEncode(segment))
      .join("/")}`
  );
  if (input.responseContentDisposition !== undefined) {
    url.searchParams.set(
      "response-content-disposition",
      input.responseContentDisposition
    );
  }
  return presignS3Url({
    ...store.credentials,
    expiresSeconds: input.expiresSeconds,
    method: input.method,
    now: input.now ?? new Date(),
    region: store.region,
    url: url.href,
  });
}

/**
 * Whether the bucket and a key to sign for it are configured: the `S3_*`
 * pair, or Cloud.ru's tenant, key id and secret.
 */
export function objectStorageConfigured() {
  return (
    env.BROWSER_STATE_BUCKET !== undefined &&
    (providerKey() !== undefined || cloudruKey() !== undefined)
  );
}

/**
 * The bucket, the address and region it is signed for and the key that signs.
 * The `S3_*` settings win when their key is set (a plain access key id, for
 * the endpoint and region next to it); otherwise it is Cloud.ru's, whose S3
 * key is the tenant and the access key id together.
 */
export function objectStore() {
  const bucket = env.BROWSER_STATE_BUCKET;
  const provider = providerKey();
  if (provider !== undefined && bucket !== undefined) {
    const endpoint = env.S3_ENDPOINT;
    const region = env.S3_REGION;
    if (endpoint === undefined || region === undefined) {
      throw new Error(
        "S3_ENDPOINT and S3_REGION are not configured next to S3_ACCESS_KEY_ID."
      );
    }
    return { bucket, credentials: provider, endpoint, region };
  }
  const cloudru = cloudruKey();
  if (cloudru === undefined || bucket === undefined) {
    throw new Error(
      "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or CLOUDRU_S3_TENANT_ID, CLOUDRU_KEY_ID and CLOUDRU_KEY_SECRET) and BROWSER_STATE_BUCKET are not configured."
    );
  }
  return { bucket, credentials: cloudru, ...cloudruObjectStorage };
}

function providerKey() {
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    return undefined;
  }
  return { accessKeyId, secretAccessKey };
}

function cloudruKey() {
  const tenant = env.CLOUDRU_S3_TENANT_ID;
  const keyId = env.CLOUDRU_KEY_ID;
  const secret = env.CLOUDRU_KEY_SECRET;
  if (tenant === undefined || keyId === undefined || secret === undefined) {
    return undefined;
  }
  return { accessKeyId: `${tenant}:${keyId}`, secretAccessKey: secret };
}
