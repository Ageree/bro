import { z } from "zod";
import { getAuthSession } from "@db/services/auth/session";
import { readReadyArtifact } from "@db/services/artifacts";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  artifactStorageConfigured,
  openArtifactObject,
} from "@shared/object-storage/artifacts";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/artifacts/[artifactId]">
) {
  const session = await getAuthSession(request.headers);
  const parsedId = z.uuid().safeParse((await context.params).artifactId);
  if (!session || !parsedId.success) return notFound();

  const scope = accessScopeForUser(`better-auth:${session.user.id}`);
  const artifact = await readReadyArtifact(scope, parsedId.data);
  if (!artifact || !artifactStorageConfigured()) return notFound();

  let result: Awaited<ReturnType<typeof openArtifactObject>>;
  try {
    result = await openArtifactObject(artifact.storagePathname, {
      ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
      signal: request.signal,
    });
  } catch (error) {
    // Object Storage refused, timed out or dropped the connection.
    console.error("[artifacts] Object Storage read failed", error);
    return new Response("Storage unavailable", {
      headers: privateImageHeaders(),
      status: 502,
    });
  }
  if (!result) return notFound();

  const headers = privateImageHeaders();
  if (result.etag) headers.set("etag", result.etag);
  if (result.status === 304) {
    return new Response(null, { headers, status: 304 });
  }
  if (
    result.size !== artifact.byteSize ||
    result.contentType !== artifact.mediaType
  ) {
    await result.stream.cancel();
    return notFound();
  }

  headers.set("content-length", String(artifact.byteSize));
  headers.set("content-type", artifact.mediaType);
  headers.set(
    "content-disposition",
    contentDisposition(artifact.filename, artifact.mediaType)
  );
  return new Response(result.stream, { headers, status: 200 });
}

function notFound() {
  return new Response("Not found", {
    headers: privateImageHeaders(),
    status: 404,
  });
}

function privateImageHeaders() {
  return new Headers({
    "cache-control": "private, max-age=3600",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

/**
 * Images open in place. Anything else, such as a PDF from a mail attachment,
 * downloads: the sandbox policy on this response keeps a browser from
 * rendering it inline.
 */
function contentDisposition(filename: string, mediaType: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
  const disposition = mediaType.startsWith("image/") ? "inline" : "attachment";
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
