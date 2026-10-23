import * as z from "zod";
import { readCardByLink } from "@db/services/cards";
import { cardPhotoObject, keptPhotoNumbers } from "@shared/cards/photos";
import {
  artifactStorageConfigured,
  openArtifactObject,
} from "@shared/object-storage/artifacts";

export const runtime = "nodejs";

const photoTypes: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const numberSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,2})$/u)
  .transform(Number);

/**
 * A photo of a card: Bro's own copy (`shared/cards/photos.ts`), read by the
 * card's link. Whoever holds the link sees the card and its photos, as the
 * page does; a photo the card does not show (it expired, never had that
 * number, or showed it before an update) is the same 404 as a card that never
 * was. The address carries the secret, so nothing here logs it.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/cards/[id]/photos/[n]">
) {
  const { id, n } = await context.params;
  const number = numberSchema.safeParse(n);
  if (!number.success || !artifactStorageConfigured()) return notFound();
  const card = await readCardByLink(id);
  if (!card || !keptPhotoNumbers(id, card).includes(number.data)) {
    return notFound();
  }

  let result: Awaited<ReturnType<typeof openArtifactObject>>;
  try {
    result = await openArtifactObject(cardPhotoObject(id, number.data), {
      ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
      signal: request.signal,
    });
  } catch (error) {
    console.error("[cards] a photo could not be read", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return new Response("Storage unavailable", {
      headers: photoHeaders("private, no-store"),
      status: 502,
    });
  }
  if (!result) return notFound();

  const headers = photoHeaders("private, max-age=86400");
  if (result.etag) headers.set("etag", result.etag);
  if (result.status === 304) {
    return new Response(null, { headers, status: 304 });
  }
  if (!result.contentType || !photoTypes.has(result.contentType)) {
    await result.stream.cancel().catch(() => undefined);
    return notFound();
  }
  headers.set("content-type", result.contentType);
  if (Number.isSafeInteger(result.size)) {
    headers.set("content-length", String(result.size));
  }
  return new Response(result.stream, { headers, status: 200 });
}

function notFound() {
  return new Response("Not found", {
    headers: photoHeaders("private, no-store"),
    status: 404,
  });
}

function photoHeaders(cacheControl: string) {
  return new Headers({
    "cache-control": cacheControl,
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}
