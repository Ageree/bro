/**
 * How long a request to Object Storage may take, for the app
 * (`artifacts.ts`) and for the Blob copy script
 * (`scripts/cloudru-app-host/blob-to-s3.ts`, which imports this file by its
 * relative path and so must keep it free of other imports).
 */
export const objectRequestTimeoutMs = 60_000;
/** The slowest upload a PUT waits out: 10 MB in under four minutes. */
const slowestUploadBytesPerSecond = 64 * 1024;

/**
 * The deadline of a PUT: the bound of a read plus the time its body needs at
 * the slowest rate, so a large attachment is not cut off mid-upload.
 */
export function uploadTimeoutMs(byteLength: number) {
  return (
    objectRequestTimeoutMs +
    Math.ceil(byteLength / slowestUploadBytesPerSecond) * 1000
  );
}
