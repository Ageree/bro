import { objectStore, presignStoredObject } from "@shared/object-storage/s3";
import { presignS3Url, uriEncode } from "@shared/object-storage/sigv4";

/**
 * Bro's own reads, listings and deletions in the bucket of
 * `@shared/object-storage/s3`, through the same presigned URLs a host gets.
 */
const requestTimeoutMs = 30_000;
/** Deletions sent at once when a prefix goes. */
const parallelDeletes = 8;

type S3Method = "DELETE" | "GET";

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

/** The keys of the bucket's objects under `prefix`, every page of them. */
export async function listBrowserStateObjects(prefix: string) {
  const store = objectStore();
  const keys: string[] = [];
  let continuation: string | undefined;
  do {
    const listing = new URL(`${store.endpoint}/${uriEncode(store.bucket)}`);
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
        region: store.region,
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
      presignStoredObject({ expiresSeconds: 300, key, method: "GET" })
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
export async function readBrowserStateObjectBytes(
  key: string,
  timeoutMs = requestTimeoutMs
) {
  const response = await fetch(
    presignStoredObject({ expiresSeconds: 300, key, method: "GET" }),
    { signal: AbortSignal.timeout(timeoutMs) }
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
            presignStoredObject({
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
