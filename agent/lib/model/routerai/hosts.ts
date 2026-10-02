import { z } from "zod";

/**
 * How long a pinned RouterAI host that failed an answer is skipped. On 01.10
 * Sail Research failed one call after another for minutes («The model worker
 * could not complete this request», a chunk with `finish_reason: "error"`):
 * RouterAI does not move a call to the next host of `provider.order` once it
 * has begun to stream, and eve's retry of the step went to the same first
 * host, so 7 of 8 `schedules` eval turns ran out their time.
 */
const skippedForMs = 10 * 60_000;

/** When each pinned host last failed an answer, by its slug. */
const failedAt = new Map<string, number>();

/** A display name («Sail Research») and a slug («sail-research») as one key. */
function hostKey(name: string) {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

const routedBodySchema = z
  .object({
    provider: z
      .object({
        ignore: z.array(z.string()).optional(),
        order: z.array(z.string()).optional(),
      })
      .loose(),
  })
  .loose();

/** The request's JSON body with its provider routing, if it has one. */
function routedBody(body: string) {
  try {
    return routedBodySchema.safeParse(JSON.parse(body)).data;
  } catch {
    return undefined;
  }
}

function recentlyFailed(slug: string, now: number) {
  const at = failedAt.get(slug);
  return at !== undefined && now - at < skippedForMs;
}

/**
 * The request body with every pinned host that failed an answer lately moved
 * from `provider.order` to `provider.ignore`, so RouterAI routes the call to
 * the next host. A body without pinned hosts passes unchanged.
 */
export function routedAroundFailedHosts(body: string, now = Date.now()) {
  const parsed = routedBody(body);
  const order = parsed?.provider.order ?? [];
  const failed = order.filter((slug) => recentlyFailed(slug, now));
  if (parsed === undefined || failed.length === 0) return body;
  const kept = order.filter((slug) => !failed.includes(slug));
  const provider: (typeof parsed)["provider"] = {
    ...parsed.provider,
    ignore: [...new Set([...(parsed.provider.ignore ?? []), ...failed])],
    order: kept,
  };
  // An empty order would pin nothing; without one RouterAI routes itself.
  if (kept.length === 0) delete provider.order;
  return JSON.stringify({ ...parsed, provider });
}

/**
 * Notes that a host failed an answer to this request. Only a host the
 * request pinned counts, because only its slug is known for sure: `true`
 * means the next call of the same body goes elsewhere.
 */
export function noteFailedHost(body: string, host: string, now = Date.now()) {
  const order = routedBody(body)?.provider.order ?? [];
  const slug = order.find((pinned) => hostKey(pinned) === hostKey(host));
  if (slug === undefined) return false;
  failedAt.set(slug, now);
  return true;
}
