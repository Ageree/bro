import * as z from "zod";
import { env } from "@shared/environment";

/**
 * Travelpayouts partner links (support.travelpayouts.com, «API for
 * Travelpayouts partner links»): a link Bro sends to a travel brand's page
 * goes out as the owner's partner link, so a booking the person makes there
 * earns the owner a commission. `POST /links/v1/create` takes up to 10 links
 * a call and 100 calls a minute per marker. A brand the project is not
 * subscribed to answers `failed` for its link (26.10: the bot's project had
 * only Aviasales), and any failure leaves the link as Bro wrote it: the
 * person never waits on Travelpayouts for more than `requestTimeoutMs`.
 *
 * Only the brands below are asked, so no other address the person gets
 * reaches Travelpayouts; and no id of the person goes with a link.
 */

const apiUrl = "https://api.travelpayouts.com/links/v1/create";
const linksPerCall = 10;
const requestTimeoutMs = 2500;
const keptMs = 24 * 3_600_000;
/** A brand that answered `failed` is asked again after this. */
const refusedMs = 10 * 60_000;
/** After a failed call, its links go out as written for this long. */
const failedCallMs = 60_000;
const cachedLinks = 2000;

/** The brands asked, by host: the one named and its subdomains. */
const brandHosts = ["ostrovok.ru", "travel.yandex.ru", "aviasales.ru"];

/** Where a link goes out from, for the owner's statistics (`sub_id`). */
type PartnerLinkSurface = "card" | "message";

/**
 * Whether the workspace's links go out as partner links
 * (PARTNER_LINKS_WORKSPACES: its id or `*`) and the deployment has all the
 * Travelpayouts settings.
 */
export function partnerLinksPilot(scope: { readonly workspaceId: string }) {
  const list = env.PARTNER_LINKS_WORKSPACES ?? [];
  return (
    env.TRAVELPAYOUTS_TOKEN !== undefined &&
    env.TRAVELPAYOUTS_MARKER !== undefined &&
    env.TRAVELPAYOUTS_TRS !== undefined &&
    (list.includes("*") || list.includes(scope.workspaceId))
  );
}

/** Whether the address is an https page of a brand asked for partner links. */
export function brandLink(address: string) {
  const url = URL.parse(address);
  if (url?.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return brandHosts.some(
    (brand) => host === brand || host.endsWith(`.${brand}`)
  );
}

const answerSchema = z.object({
  result: z.object({
    links: z.array(
      z.object({
        url: z.string(),
        code: z.string(),
        partner_url: z.string().optional(),
      })
    ),
  }),
});

/** Each address's partner link, or none until `until`. */
const cache = new Map<
  string,
  { readonly link: string | undefined; readonly until: number }
>();

/**
 * The partner link of each brand address among `addresses` that has one.
 * An address missing from the result goes out as written.
 */
export async function partnerLinks(
  addresses: readonly string[],
  surface: PartnerLinkSurface,
  now = Date.now()
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  const asked: string[] = [];
  for (const address of new Set(addresses.filter(brandLink))) {
    const known = cache.get(address);
    if (known === undefined || known.until <= now) {
      asked.push(address);
      continue;
    }
    if (known.link !== undefined) found.set(address, known.link);
  }
  const calls = [];
  for (let start = 0; start < asked.length; start += linksPerCall) {
    calls.push(
      createLinks(asked.slice(start, start + linksPerCall), surface, now)
    );
  }
  for (const made of await Promise.all(calls)) {
    for (const [address, link] of made) found.set(address, link);
  }
  return found;
}

async function createLinks(
  addresses: readonly string[],
  surface: PartnerLinkSurface,
  now: number
) {
  const made = new Map<string, string>();
  try {
    const response = await fetch(apiUrl, {
      body: JSON.stringify({
        links: addresses.map((url) => ({ sub_id: surface, url })),
        marker: env.TRAVELPAYOUTS_MARKER,
        shorten: true,
        trs: env.TRAVELPAYOUTS_TRS,
      }),
      headers: {
        "content-type": "application/json",
        "x-access-token": env.TRAVELPAYOUTS_TOKEN ?? "",
      },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Travelpayouts answered ${String(response.status)}`);
    }
    const { links } = answerSchema.parse(await response.json()).result;
    for (const address of addresses) {
      const link = links.find((each) => each.url === address);
      const partner =
        link?.code === "success" &&
        link.partner_url !== undefined &&
        URL.parse(link.partner_url)?.protocol === "https:"
          ? link.partner_url
          : undefined;
      remember(address, partner, now + (partner ? keptMs : refusedMs));
      if (partner) made.set(address, partner);
    }
    const refused = addresses.length - made.size;
    if (refused > 0) {
      // No address: it may name the person's trip.
      console.warn("[partner-links] links left as written", {
        refused,
        surface,
      });
    }
  } catch (error) {
    for (const address of addresses) {
      remember(address, undefined, now + failedCallMs);
    }
    console.warn("[partner-links] Travelpayouts did not answer", {
      links: addresses.length,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
  return made;
}

function remember(address: string, link: string | undefined, until: number) {
  cache.delete(address);
  cache.set(address, { link, until });
  if (cache.size <= cachedLinks) return;
  const [oldest] = cache.keys();
  if (oldest !== undefined) cache.delete(oldest);
}
