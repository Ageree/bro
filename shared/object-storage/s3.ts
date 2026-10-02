import { env } from "@shared/environment";
import {
  objectStorageEndpoint,
  objectStorageRegion,
  presignS3Url,
  uriEncode,
} from "@shared/object-storage/sigv4";

/**
 * Bro's bucket in Object Storage on Cloud.ru (S3, `ru-central-1`),
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
  const url = new URL(
    `${objectStorageEndpoint}/${uriEncode(store.bucket)}/${input.key
      .split("/")
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
    region: objectStorageRegion,
    url: url.href,
  });
}

/** Whether the bucket and the key to sign for it are configured. */
export function objectStorageConfigured() {
  return (
    env.CLOUDRU_S3_TENANT_ID !== undefined &&
    env.CLOUDRU_KEY_ID !== undefined &&
    env.CLOUDRU_KEY_SECRET !== undefined &&
    env.BROWSER_STATE_BUCKET !== undefined
  );
}

/** The bucket and the key that signs for it. */
export function objectStore() {
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
