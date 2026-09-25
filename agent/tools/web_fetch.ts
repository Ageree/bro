import { defineDynamic, defineTool } from "eve/tools";
import {
  WEB_FETCH_INPUT_SCHEMA,
  WEB_FETCH_OUTPUT_SCHEMA,
  type WebFetchToolOutput,
  webFetch,
} from "eve/tools/web_fetch";
import { resolveModeValue } from "@agent/lib/mode";
import {
  botCheckWording,
  challengeWording,
} from "@agent/lib/web-page/challenge";

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
/** Plenty for the conversations one instance serves; the oldest go first. */
const maximumRememberedHosts = 500;
/**
 * Statuses a site answers bots with. A 401 is not one: it means this page
 * needs a login, and the next page of the same site may well be public.
 */
const refusalStatuses: ReadonlySet<number> = new Set([403, 429, 451]);
/** A challenge page is tiny, and its title and heading are its first lines. */
const challengePageCharacters = 4000;
const challengeHeadLines = 2;
/** Fewer letters than this on a map page means only its JavaScript shell came back. */
const readableLetters = 300;
/**
 * Link shorteners hand the request to another site, and eve reports the
 * address asked for, so a refusal behind one is not the shortener's.
 */
const redirectHosts: ReadonlySet<string> = new Set([
  "bit.ly",
  "clck.ru",
  "goo.gl",
  "goo.su",
  "is.gd",
  "t.co",
  "tinyurl.com",
  "vk.cc",
  "ya.cc",
]);

/**
 * Hosts that refused or hung, per conversation, until when and why. One
 * conversation's failure never answers another's fetch, so a crafted page
 * cannot close a site for everyone on the instance.
 */
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

/** A note in place of the page; `wholeSite` when the site itself refused. */
function unreadable(url: string, reason: string, wholeSite: boolean) {
  const retry = wholeSite
    ? " Do not fetch it or other pages of this site again now."
    : "";
  return {
    content: `web_fetch could not read this page: ${reason}.${retry} ${adviceFor(URL.parse(url))}`,
    contentType: "text/plain",
    truncated: false,
    url,
  };
}

/** Where this conversation's memory of a host lives; none for a shortener. */
function memoryKey(url: URL | null, sessionId: string) {
  const host = url?.hostname.replace(/^www\./u, "");
  if (!host || redirectHosts.has(host)) return undefined;
  return `${sessionId} ${host}`;
}

/** Why the host was recently given up on, while that is still fresh. */
function recentRefusal(key: string, now: number) {
  const refusal = refusingHosts.get(key);
  if (!refusal) return undefined;
  if (now < refusal.until) return refusal.reason;
  refusingHosts.delete(key);
  return undefined;
}

function giveUpOn(key: string | undefined, reason: string, forMs: number) {
  if (key === undefined) return;
  const now = Date.now();
  for (const [known, refusal] of refusingHosts) {
    if (refusal.until <= now) refusingHosts.delete(known);
  }
  refusingHosts.delete(key);
  refusingHosts.set(key, { reason, until: now + forMs });
  // A Map iterates in insertion order, so the first keys are the oldest.
  for (const oldest of refusingHosts.keys()) {
    if (refusingHosts.size <= maximumRememberedHosts) break;
    refusingHosts.delete(oldest);
  }
}

/**
 * The status eve puts in front of a page that was not 2xx. Only these
 * refusals close the site for the conversation: they come from the site,
 * whatever the page happens to say.
 */
function refusalStatus(content: string) {
  const status = /^Request failed with status code: (\d{3})/u.exec(content);
  const code = status ? Number(status[1]) : undefined;
  return code !== undefined && refusalStatuses.has(code) ? code : undefined;
}

/**
 * A captcha or bot check served in place of the page. Its wording is only
 * trusted in the title and heading of a tiny page, and a block page's words
 * only with an error status: «защищено reCAPTCHA» under a form or a headline
 * «Доступ запрещён» on a real page is content.
 */
function looksLikeChallenge(content: string) {
  if (content.length > challengePageCharacters) return false;
  const failed = /^Request failed with status code: \d{3}/u.exec(content);
  const head = content
    .slice(failed?.[0].length ?? 0)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, challengeHeadLines)
    .join("\n");
  return (failed ? challengeWording : botCheckWording).test(head);
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
    "- When a site answers with a block or does not answer in time, the result is a short note saying so and what to use instead, and this conversation does not fetch that site again for a few minutes. A page that is only a captcha comes back as such a note too.",
    '- Yandex Maps and 2GIS pages rarely open this way. For a place\'s rating, average bill, address and hours call web_search with sites ["yandex.ru/maps"] or ["2gis.ru"] instead.',
    "- Content is capped at 50 KB / 2000 lines.",
  ].join("\n"),
  inputSchema: WEB_FETCH_INPUT_SCHEMA.extend({
    timeout: WEB_FETCH_INPUT_SCHEMA.shape.timeout.describe(
      `Seconds to wait for the page. Defaults to ${String(defaultTimeoutSeconds)}, at most ${String(maximumTimeoutSeconds)}.`
    ),
  }),
  label: {
    start: ({ url }) => `Fetch ${URL.parse(url)?.hostname ?? url}`,
  },
  outputSchema: webFetch.outputSchema,
  async execute(input, ctx) {
    const url = URL.parse(input.url);
    const key = memoryKey(url, ctx.session.id);
    const remembered = key ? recentRefusal(key, Date.now()) : undefined;
    if (remembered) {
      return unreadable(
        input.url,
        `${remembered} a few minutes ago, so it was not asked again`,
        true
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
      giveUpOn(key, reason, timeoutMemoryMs);
      return unreadable(input.url, reason, true);
    }
    const status = refusalStatus(page.content);
    if (status !== undefined) {
      const reason = `the site refused automated reading (HTTP ${String(status)})`;
      giveUpOn(key, reason, refusalMemoryMs);
      return unreadable(input.url, reason, true);
    }
    if (looksLikeChallenge(page.content)) {
      return unreadable(
        input.url,
        "the page is a captcha or bot check, not the content",
        false
      );
    }
    const map = url ? mapService(url) : undefined;
    if (map && (page.content.match(/\p{L}/gu) ?? []).length < readableLetters) {
      return unreadable(
        input.url,
        `${map.name} sent only its JavaScript shell, without the place's card`,
        false
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
