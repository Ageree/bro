import { lookup } from "node:dns/promises";
import { z } from "zod";

const lookupTimeoutMs = 3_000;

const resolverErrorSchema = z.object({ code: z.string() });

/** The host of a site named as an origin or as a bare domain. */
export function siteHostname(site: string) {
  const trimmed = site.trim();
  try {
    return (
      new URL(
        /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed)
          ? trimmed
          : `https://${trimmed}`
      ).hostname || undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Whether a site's name does not exist at all. An errand pointed at an
 * address Bro made up rather than found meets a proxy that cannot resolve it,
 * which the browser shows as «ERR_TUNNEL_CONNECTION_FAILED» — and that was
 * retried as an anti-bot wall for half an hour. Only the resolver's plain
 * answer that the name does not exist counts: a lookup that times out or
 * fails for any other reason says nothing about the site and holds nothing up.
 */
export async function siteHostMissing(site: string) {
  const host = siteHostname(site);
  if (host === undefined) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      nameNotFound(host),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, lookupTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function nameNotFound(host: string) {
  try {
    await lookup(host);
    return false;
  } catch (error) {
    return resolverErrorSchema.safeParse(error).data?.code === "ENOTFOUND";
  }
}
