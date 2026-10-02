/**
 * Copies Bro's images and attachments from Vercel Blob to Object Storage on
 * Cloud.ru, under the key the app now reads (`artifacts/` plus the Blob
 * pathname the database rows record, `shared/object-storage/artifacts.ts`).
 * Blob itself is only read.
 *
 *   node --experimental-strip-types scripts/cloudru-app-host/blob-to-s3.ts [--dry-run]
 *   node --experimental-strip-types scripts/cloudru-app-host/blob-to-s3.ts --verify
 *
 * Environment: BROWSER_STATE_BUCKET, CLOUDRU_S3_TENANT_ID, CLOUDRU_KEY_ID,
 * CLOUDRU_KEY_SECRET; to copy, BLOB_READ_WRITE_TOKEN (the store to copy);
 * to verify, DATABASE_URL (only read).
 *
 * Safe to run again: an object already in the bucket with the same size and
 * the same content type as in Blob is left alone, so a second run copies
 * only what is new or landed wrong (the `/artifacts` route refuses an object
 * whose type differs from its row).
 *
 * `--verify` checks the real acceptance: every artifact row in the database
 * that names a stored object (browser, generated and reference images, Gmail
 * and Drive files) has it in the bucket with the row's size and media type.
 * Run it after the last copy and before the switch.
 * Each copy is checked by size, by sha256 where the last path segment is
 * the hash of the bytes, and by a HEAD of what landed. The installation
 * secrets under `openinstinct/system/` stay behind: they live in the
 * environment now. Prints only a summary, never a path or a key.
 */
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { z } from "zod";
import {
  objectStorageEndpoint,
  objectStorageRegion,
  presignS3Url,
  uriEncode,
} from "../../shared/object-storage/sigv4.ts";

/** Must match `artifactKeyPrefix` in `shared/object-storage/artifacts.ts`. */
const keyPrefix = "artifacts/";
const skippedPrefix = "openinstinct/system/";
const blobApi = "https://vercel.com/api/blob";
const blobApiVersion = "12";
/** Folders whose last path segment is the sha256 of the object's bytes. */
const hashedFolders = [
  "browser-images/",
  "generated-images/",
  "reference-photos/",
];
const requestTimeoutMs = 120_000;
/** A dropped connection is retried; an answer, even a refusal, is not. */
const networkAttempts = 4;

const { values: options } = parseArgs({
  options: {
    "dry-run": { default: false, type: "boolean" },
    verify: { default: false, type: "boolean" },
  },
});
const dryRun = options["dry-run"];

const bucket = setting("BROWSER_STATE_BUCKET");
const credentials = {
  accessKeyId: `${setting("CLOUDRU_S3_TENANT_ID")}:${setting("CLOUDRU_KEY_ID")}`,
  secretAccessKey: setting("CLOUDRU_KEY_SECRET"),
};

const listedBlobSchema = z.object({
  pathname: z.string().min(1),
  size: z.number().int().nonnegative(),
  url: z.url(),
});
const listingSchema = z.object({
  blobs: z.array(listedBlobSchema),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
});
type ListedBlob = z.infer<typeof listedBlobSchema>;

if (options.verify) {
  await verifyRows();
} else {
  await copyAll();
}

async function copyAll() {
  const token = setting("BLOB_READ_WRITE_TOKEN");
  // `vercel_blob_rw_<store id>_<secret>`
  const storeId = token.split("_")[3] ?? "";
  const summary = {
    bytesCopied: 0,
    copied: 0,
    failed: 0,
    listed: 0,
    present: 0,
    skippedSystem: 0,
    toCopy: 0,
  };
  const failures = new Map<string, number>();

  for (const blob of await listBlobs()) {
    summary.listed += 1;
    if (blob.pathname.startsWith(skippedPrefix)) {
      summary.skippedSystem += 1;
      continue;
    }
    const key = `${keyPrefix}${blob.pathname}`;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One object at a time: a few dozen megabytes in all.
      const stored = await headObject(key);
      const present =
        stored?.size === blob.size &&
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        stored.contentType === (await blobContentType(blob));
      if (present) {
        summary.present += 1;
        continue;
      }
      summary.toCopy += 1;
      if (dryRun) continue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await copy(blob, key);
      summary.copied += 1;
      summary.bytesCopied += blob.size;
    } catch (error) {
      summary.failed += 1;
      const reason = error instanceof Error ? error.message : "unknown";
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
  }

  console.log(
    JSON.stringify(
      { dryRun, ...summary, failures: Object.fromEntries(failures) },
      null,
      2
    )
  );
  if (summary.failed > 0) process.exitCode = 1;

  /**
   * The type Blob serves an object with, the one its row records: the listing
   * does not carry it. S3 always reports some type, so only an equal one
   * counts as already copied.
   */
  async function blobContentType(blob: ListedBlob) {
    const response = await send(blob.url, {
      headers: { authorization: `Bearer ${token}` },
      method: "HEAD",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Blob HEAD answered ${String(response.status)}.`);
    }
    return response.headers.get("content-type") ?? "";
  }

  async function listBlobs() {
    const blobs: ListedBlob[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL(blobApi);
      url.searchParams.set("limit", "1000");
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the previous page's cursor.
      const response = await send(url, {
        headers: {
          authorization: `Bearer ${token}`,
          "x-api-version": blobApiVersion,
          "x-vercel-blob-store-id": storeId,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Blob list answered ${String(response.status)}.`);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      const page = listingSchema.parse(await response.json());
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor !== undefined);
    return blobs;
  }

  async function copy(blob: ListedBlob, key: string) {
    const response = await send(blob.url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Blob GET answered ${String(response.status)}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (contentType === "") throw new Error("Blob gave no content type.");
    if (bytes.byteLength !== blob.size) {
      throw new Error("Blob bytes differ from the listed size.");
    }
    if (hashedFolders.some((folder) => blob.pathname.startsWith(folder))) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== blob.pathname.split("/").at(-1)) {
        throw new Error("Blob bytes differ from the hash in their path.");
      }
    }
    const put = await send(presign("PUT", key), {
      body: bytes,
      headers: { "content-type": contentType },
      method: "PUT",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    await put.body?.cancel();
    if (!put.ok) throw new Error(`S3 PUT answered ${String(put.status)}.`);
    const landed = await headObject(key);
    if (landed?.size !== blob.size || landed.contentType !== contentType) {
      throw new Error("S3 holds a different size or type after the copy.");
    }
  }
}

/** Every stored artifact row against the bucket; prints counts only. */
async function verifyRows() {
  const rows = await storedArtifactRows();
  const counts = {
    failed: 0,
    matching: 0,
    missing: 0,
    rows: rows.length,
    wrongSize: 0,
    wrongType: 0,
  };
  for (const row of rows) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One object at a time: a few hundred at most.
      const stored = await headObject(`${keyPrefix}${row.storage_pathname}`);
      if (stored === undefined) counts.missing += 1;
      else if (stored.size !== row.byte_size) counts.wrongSize += 1;
      else if (stored.contentType !== row.media_type) counts.wrongType += 1;
      else counts.matching += 1;
    } catch {
      counts.failed += 1;
    }
  }
  console.log(JSON.stringify({ verify: true, ...counts }, null, 2));
  if (counts.matching !== counts.rows) process.exitCode = 1;
}

/** The rows that name a stored object, in a read-only session. */
async function storedArtifactRows() {
  const client = new Client({ connectionString: setting("DATABASE_URL") });
  await client.connect();
  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const result = await client.query<{
      byte_size: number;
      media_type: string;
      storage_pathname: string;
    }>(
      `SELECT storage_pathname, byte_size, media_type FROM browser_image_artifacts WHERE status = 'ready'
       UNION ALL SELECT storage_pathname, byte_size, media_type FROM generated_image_artifacts
       UNION ALL SELECT storage_pathname, byte_size, media_type FROM gmail_attachment_artifacts
       UNION ALL SELECT storage_pathname, byte_size, media_type FROM drive_file_artifacts`
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function headObject(key: string) {
  const response = await send(presign("HEAD", key), {
    method: "HEAD",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`S3 HEAD answered ${String(response.status)}.`);
  }
  return {
    contentType: response.headers.get("content-type") ?? "",
    size: Number(response.headers.get("content-length")),
  };
}

function presign(method: "HEAD" | "PUT", key: string) {
  return presignS3Url({
    ...credentials,
    expiresSeconds: 600,
    method,
    now: new Date(),
    region: objectStorageRegion,
    url: `${objectStorageEndpoint}/${uriEncode(bucket)}/${key
      .split("/")
      .map((segment) => uriEncode(segment))
      .join("/")}`,
  });
}

/**
 * `fetch`, again after a dropped connection: the way out of the cloud
 * session sometimes resets one. Every request here is safe to repeat.
 */
async function send(input: string | URL, init: RequestInit) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A retry waits for the attempt before it.
      return await fetch(input, init);
    } catch (error) {
      if (attempt >= networkAttempts) {
        const cause =
          error instanceof Error && error.cause instanceof Error
            ? `: ${error.cause.message}`
            : "";
        throw new Error(
          `${error instanceof Error ? error.message : "fetch"}${cause}`,
          { cause: error }
        );
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

/** A setting as pasted: whitespace, newlines and quotes around it removed. */
function setting(name: string) {
  // oxlint-disable-next-line eslint/no-restricted-properties -- A standalone maintenance script, outside the app's validated environment.
  const value = (process.env[name] ?? "")
    .replaceAll(/\s+/gu, "")
    .replaceAll(/^['"‘’“”]+|['"‘’“”]+$/gu, "");
  if (value === "") throw new Error(`${name} is not set.`);
  return value;
}
