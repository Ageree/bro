import { defineDynamic, defineTool } from "eve/tools";
import {
  WEB_FETCH_OUTPUT_SCHEMA,
  type WebFetchToolOutput,
  webFetch,
} from "eve/tools/web_fetch";
import { resolveModeValue } from "@agent/lib/mode";
import { challengeWording } from "@agent/lib/web-page/challenge";

/**
 * eve waits 30 s by default. A recommendation reads several pages, and one
 * that hangs would hold the whole turn that long.
 */
const defaultTimeoutSeconds = 12;
const maximumTimeoutSeconds = 30;
/** How long a host that refused is answered without asking it again. */
const refusalMemoryMs = 10 * 60_000;
/** A host that only hung may just have been slow, so it is given up on for less. */
const timeoutMemoryMs = 3 * 60_000;
/** Statuses a site answers automated reading with rather than a missing page. */
const refusalStatuses: ReadonlySet<number> = new Set([401, 403, 429, 451]);
/** A challenge page is short; a real article that mentions a captcha is not. */
const challengePageCharacters = 20_000;
/** Where the title and heading of a challenge page land in the Markdown. */
const challengeTopCharacters = 1500;
/** Fewer letters than this on a map page means only its JavaScript shell came back. */
const readableLetters = 300;

/** Hosts that refused or hung on this instance, until when and why. */
const refusingHosts = new Map<
  string,
  { readonly reason: string; readonly until: number }
>();

/**
 * Yandex Maps and 2GIS keep a place's rating, average bill, address and hours
 * in pages that answer automated reading with a captcha or a JavaScript
 * shell. Their search excerpts carry the same card.
 */
function mapService(url: URL) {
  const host = url.hostname.replace(/^www\./u, "");
  if (
    (/^yandex\.(?:ru|com|by|kz|uz)$/u.test(host) &&
      url.pathname.startsWith("/maps")) ||
    host === "maps.yandex.ru"
  ) {
    return { name: "Yandex Maps", site: "yandex.ru/maps" };
  }
  if (/(?:^|\.)2gis\.(?:ru|com|kz|ae)$/u.test(host)) {
    return { name: "2GIS", site: "2gis.ru" };
  }
  return undefined;
}

function adviceFor(url: URL | null) {
  const map = url ? mapService(url) : undefined;
  if (map) {
    return `For a place's rating, average bill, address and hours call web_search with sites: ["${map.site}"] and the place's name: the ${map.name} card comes back as a search excerpt. Aggregators (restoclub.ru, afisha.ru, zoon.ru, eatout.ru, yell.ru) and the place's own site have the rest.`;
  }
  return "Get the same facts from web_search excerpts or another site, or open this page with a browser task when one is available and the page itself matters.";
}

function unreadable(input: { readonly url: string }, reason: string) {
  return {
    content: `web_fetch could not read this page: ${reason}. Do not fetch it or other pages of this site again now. ${adviceFor(URL.parse(input.url))}`,
    contentType: "text/plain",
    truncated: false,
    url: input.url,
  };
}

/** Why a host was recently given up on, while that is still fresh. */
function recentRefusal(host: string, now: number) {
  const refusal = refusingHosts.get(host);
  if (!refusal) return undefined;
  if (now < refusal.until) return refusal.reason;
  refusingHosts.delete(host);
  return undefined;
}

function giveUpOn(host: string | undefined, reason: string, forMs: number) {
  if (host) refusingHosts.set(host, { reason, until: Date.now() + forMs });
}

/** What in a fetched page shows the site refused it rather than served it. */
function refusalIn(content: string) {
  const status = /^Request failed with status code: (\d{3})/u.exec(content);
  const code = status ? Number(status[1]) : undefined;
  if (code !== undefined && refusalStatuses.has(code)) {
    return `the site refused automated reading (HTTP ${String(code)})`;
  }
  if (
    content.length < challengePageCharacters &&
    challengeWording.test(content.slice(0, challengeTopCharacters))
  ) {
    return "the site answered with a captcha or bot check instead of the page";
  }
  return undefined;
}

function isTimeout(cause: unknown) {
  return cause instanceof Error && cause.name === "TimeoutError";
}

export const webFetchTool = defineTool({
  description: [
    "Fetch a public web page and return its content as Markdown (or as text or HTML). Use it to read a known URL or a page web_search found.",
    "",
    "Usage notes:",
    "- The URL must be a fully-formed https:// URL.",
    `- The page gets ${String(defaultTimeoutSeconds)} seconds by default, at most ${String(maximumTimeoutSeconds)}.`,
    "- When a site answers with a captcha or a block, or does not answer in time, the result is a short note saying so and what to use instead; that site is not fetched again for a few minutes.",
    '- Yandex Maps and 2GIS pages rarely open this way. For a place\'s rating, average bill, address and hours call web_search with sites ["yandex.ru/maps"] or ["2gis.ru"] instead.',
    "- Content is capped at 50 KB / 2000 lines.",
  ].join("\n"),
  inputSchema: webFetch.inputSchema,
  label: {
    start: ({ url }) => `Fetch ${URL.parse(url)?.hostname ?? url}`,
  },
  outputSchema: webFetch.outputSchema,
  async execute(input, ctx) {
    const url = URL.parse(input.url);
    const host = url?.hostname.replace(/^www\./u, "");
    const remembered = host ? recentRefusal(host, Date.now()) : undefined;
    if (remembered) {
      return unreadable(
        input,
        `${remembered} a few minutes ago, so it was not asked again`
      );
    }
    const timeout = Math.min(
      Math.max(input.timeout ?? defaultTimeoutSeconds, 1),
      maximumTimeoutSeconds
    );
    let page: WebFetchToolOutput;
    try {
      page = WEB_FETCH_OUTPUT_SCHEMA.parse(
        await webFetch.execute({ ...input, timeout }, ctx)
      );
    } catch (error) {
      if (ctx.abortSignal.aborted || !isTimeout(error)) throw error;
      const reason = `the site did not answer within ${String(timeout)} seconds`;
      giveUpOn(host, reason, timeoutMemoryMs);
      return unreadable(input, reason);
    }
    const refusal = refusalIn(page.content);
    if (refusal) {
      giveUpOn(host, refusal, refusalMemoryMs);
      return unreadable(input, refusal);
    }
    const map = url ? mapService(url) : undefined;
    if (map && (page.content.match(/\p{L}/gu) ?? []).length < readableLetters) {
      return unreadable(
        input,
        `${map.name} sent only its JavaScript shell, without the place's card`
      );
    }
    return page;
  },
});

export default defineDynamic({
  events: {
    // Bro's own mail checks read untrusted mail, and a report turn is handed
    // what a worker read; neither gets a way to carry that to a URL an email
    // chose. A report turn only delivers, so it never needed the web.
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { web_fetch: webFetchTool },
        "scheduled-worker": { web_fetch: webFetchTool },
      }),
  },
});
