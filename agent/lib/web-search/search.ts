import { z } from "zod";
import { providerRouting } from "@agent/lib/model/direct";
import { modelEndpoint } from "@agent/lib/model/endpoint";
import {
  failureStatus,
  reportedErrorSchema,
} from "@agent/lib/model/routerai/errors";
import { routerAiFetchOnce } from "@agent/lib/model/routerai/fetch";
import { env } from "@shared/environment";

/**
 * One attempt. With the reading model told to write nothing, both engines
 * answered 24 probes of Russian local-business queries in 1.2–7.9 s
 * (typically 2–4 s); two attempts and the pause stay under 20 s.
 */
const attemptTimeoutMs = 9000;
/** The pause before the other engine takes over. */
const retryDelayMs = 500;
/**
 * Pages one OpenRouter search asks for. RouterAI bills Exa by the page,
 * about 1.08 ₽ each on 01.10, so it asks for ROUTERAI_SEARCH_MAX_RESULTS.
 */
const openRouterMaxResults = 8;
/** Enough of a page excerpt to carry a price, an average bill, hours or an address. */
const maxSnippetCharacters = 500;
const maxSites = 5;

/**
 * The search engines, in the order they are tried. Left to choose, OpenRouter
 * runs an OpenAI model's native search: live probes on 24.09.2026 took
 * 4.7–25.7 s, past the 15 s timeout the tool then had, and 10 of 13 returned
 * no cited pages at all. Exa and Perplexity cite eight pages with excerpts at
 * a fifth of the price. The second is a different upstream, so one outage
 * does not fail the retry too.
 */
const primaryEngine = "exa";
const fallbackEngine = "perplexity";

type SearchEngine = typeof primaryEngine | typeof fallbackEngine;

export const webSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What to search the web for. Put the month or year in the query when freshness matters."
    ),
  sites: z
    .array(z.string().min(1))
    .max(maxSites)
    .optional()
    .describe(
      'Search only these sites, such as ["yandex.ru/maps"], ["2gis.ru"] or ["restoclub.ru", "afisha.ru"]. Their excerpts carry what the site says about a place (rating, average bill, address, hours) even when its pages will not open with web_fetch.'
    ),
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

/** A failed search as the backend reported it, its status read from its code. */
const reportedFailureSchema = reportedErrorSchema.transform((error) => ({
  message: error.message ?? JSON.stringify(error),
  status: failureStatus(error.code),
}));

/**
 * Both backends return the pages their `web` plugin read as OpenAI-style
 * `url_citation` annotations, each with an excerpt of the page. RouterAI
 * answers a failure with HTTP 200 and an `error` instead of `choices`, often
 * the upstream's whole JSON answer as text (probes of 01.10).
 */
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            annotations: z
              .array(
                z.object({
                  type: z.string(),
                  url_citation: z
                    .object({
                      content: z.string().optional(),
                      title: z.string().optional(),
                      url: z.string(),
                    })
                    .optional(),
                })
              )
              .optional(),
          })
          .optional(),
      })
    )
    .optional(),
  // A success may carry `error: null`; it is no failure.
  error: reportedFailureSchema
    .nullish()
    .transform((error) => error ?? undefined),
});

/** A page the model can cite or read with `web_fetch`. */
export interface WebSearchResult {
  readonly snippet: string;
  readonly title: string;
  readonly url: string;
}

/**
 * A search attempt that failed, and whether the other engine is worth a try.
 * `message` carries the backend's name and its own words for the log; `reason`
 * is all the model may hear, since it repeats the reason to the person.
 */
export class WebSearchError extends Error {
  readonly reason: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    retryable: boolean,
    reason = "the search service is not available right now"
  ) {
    super(message);
    this.name = "WebSearchError";
    this.reason = reason;
    this.retryable = retryable;
  }
}

/** The backend a search goes to: the one that serves Bro's own model. */
type SearchEndpoint = NonNullable<ReturnType<typeof modelEndpoint>>;

/**
 * Runs one web search through the `web` plugin of the direct model backend
 * (RouterAI or OpenRouter) and returns the pages it found. A timeout, a
 * throttle, a gateway failure or an empty answer hands the query to the
 * fallback engine after a short pause, and its failure is the one thrown.
 * Nothing is retried once `signal` aborts the turn.
 */
export async function searchWeb(
  input: WebSearchInput,
  signal: AbortSignal
): Promise<readonly WebSearchResult[]> {
  const endpoint = modelEndpoint();
  if (!endpoint) {
    throw new Error(
      "Web search needs a direct model backend: set ROUTERAI_API_KEY or OPENROUTER_API_KEY."
    );
  }

  try {
    return await searchOnce(input, primaryEngine, endpoint, signal);
  } catch (error) {
    if (signal.aborted || !worthRetrying(error)) throw error;
  }
  // A turn aborted during the pause fails the fetch below straight away.
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  return await searchOnce(input, fallbackEngine, endpoint, signal);
}

async function searchOnce(
  input: WebSearchInput,
  engine: SearchEngine,
  endpoint: SearchEndpoint,
  signal: AbortSignal
) {
  // On RouterAI a pinned host that failed is skipped from the next call on,
  // but the call is not repeated here: each attempt bills Exa's pages, and
  // the fallback engine below is the retry.
  const send = endpoint.provider === "routerai" ? routerAiFetchOnce : fetch;
  const response = await send(`${endpoint.baseURL}/chat/completions`, {
    body: JSON.stringify(requestBody(input, engine, endpoint)),
    headers: {
      authorization: `Bearer ${endpoint.apiKey}`,
      "content-type": "application/json",
      ...endpoint.headers,
    },
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]),
  });
  const text = await response.text();
  if (!response.ok) failed(endpoint, response.status, failureDetail(text));
  const completion = parseCompletion(text, endpoint);
  if (completion.error !== undefined && !completion.choices?.length) {
    failed(endpoint, completion.error.status, completion.error.message);
  }
  const results = readResults(completion, maxResults(endpoint));
  if (results.length === 0) {
    throw new WebSearchError("nothing was found", true, "nothing was found");
  }
  return results;
}

/**
 * Throws the failure with its status. A timeout, a throttle and a gateway
 * failure are worth the other engine; a refusal (no credit, a bad key or
 * model) fails it too. An error without a status is taken for the gateway's.
 */
function failed(
  endpoint: SearchEndpoint,
  status: number | undefined,
  detail: string
): never {
  throw new WebSearchError(
    `${endpoint.name} ${status === undefined ? "error" : String(status)}: ${detail.slice(0, 300)}`,
    status === undefined || status === 408 || status === 429 || status >= 500
  );
}

/** Whether another engine could still answer after this failure. */
function worthRetrying(cause: unknown) {
  if (cause instanceof WebSearchError) return cause.retryable;
  // A timeout of this attempt, or fetch failing to reach the backend at all.
  return (
    cause instanceof TypeError ||
    (cause instanceof Error && cause.name === "TimeoutError")
  );
}

function maxResults(endpoint: SearchEndpoint) {
  return endpoint.provider === "routerai"
    ? env.ROUTERAI_SEARCH_MAX_RESULTS
    : openRouterMaxResults;
}

/**
 * On RouterAI the reading model is routed as Bro's own model is
 * (`agent/lib/model/direct.ts`): its own DeepSeek endpoint hung for minutes
 * on 01.10 and a search waits 9 s, so the same hosts are pinned and skipped.
 * OpenRouter keeps its own routing.
 */
function searchRouting(model: string, endpoint: SearchEndpoint) {
  if (endpoint.provider !== "routerai") return {};
  const provider = providerRouting(model, endpoint);
  return provider === undefined ? {} : { provider };
}

/** The body the chat completions endpoint receives for one search. */
function requestBody(
  input: WebSearchInput,
  engine: SearchEngine,
  endpoint: SearchEndpoint
) {
  // A cheap model the plugin hands the results to; the inference default
  // when none is configured.
  const model = endpoint.searchModel;
  return {
    // The citations carry the pages and their excerpts; nothing the model
    // writes is read. Letting it summarize them cost 2–4 s per search.
    max_tokens: 16,
    messages: [
      { content: "Reply with the single word OK.", role: "system" },
      { content: input.query, role: "user" },
    ],
    model,
    plugins: [webPlugin(input, engine, maxResults(endpoint))],
    ...searchRouting(model, endpoint),
    // DeepSeek spends roughly 1,600 hidden tokens before its first visible
    // character, which buys nothing here.
    reasoning: { enabled: false },
    temperature: 0,
  };
}

/** The plugin searches with the user message; it has no date filter. */
function webPlugin(input: WebSearchInput, engine: SearchEngine, pages: number) {
  const plugin = { engine, id: "web", max_results: pages };
  const sites = siteFilter(input.sites);
  return sites.length > 0 ? { ...plugin, include_domains: sites } : plugin;
}

/** `https://www.2gis.ru/` → `2gis.ru`; a path such as `yandex.ru/maps` stays. */
function siteFilter(sites: WebSearchInput["sites"]) {
  const normalized = (sites ?? []).map((site) =>
    site
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//u, "")
      .replace(/^www\./u, "")
      .replace(/\/+$/u, "")
  );
  return [...new Set(normalized.filter((site) => site.length > 0))];
}

function readResults(
  completion: z.infer<typeof responseSchema>,
  limit: number
): readonly WebSearchResult[] {
  const message = completion.choices?.[0]?.message;
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const annotation of message?.annotations ?? []) {
    const citation =
      annotation.type === "url_citation" ? annotation.url_citation : undefined;
    if (!citation) continue;
    const url = z.url().safeParse(citation.url.trim());
    if (!url.success || seen.has(url.data)) continue;
    seen.add(url.data);
    results.push({
      snippet: excerpt(citation.content ?? ""),
      title: oneLine(citation.title ?? "") || url.data,
      url: url.data,
    });
    if (results.length === limit) break;
  }
  return results;
}

/** A failure body's error message, or the body as it came. */
function failureDetail(text: string) {
  try {
    return responseSchema.parse(JSON.parse(text)).error?.message ?? text;
  } catch {
    return text;
  }
}

function parseCompletion(text: string, endpoint: SearchEndpoint) {
  try {
    return responseSchema.parse(JSON.parse(text));
  } catch {
    throw new WebSearchError(
      `${endpoint.name} returned an unusable body.`,
      true
    );
  }
}

/**
 * Exa separates the parts of a page it picked with `...` and keeps Markdown
 * headings, links and 2GIS's zero-width spaces; one line of plain text with
 * `…` between the parts reads better and fits more into the excerpt.
 */
function excerpt(content: string) {
  return oneLine(
    content
      .replaceAll(/[​-‍⁠﻿]/gu, "")
      .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, "")
      .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replaceAll(/(?:^|\n)#{1,6}\s+/gu, "\n")
      .replaceAll(/(?:\s*(?:\[\.\.\.\]|\.{3}|…)\s*)+/gu, " … ")
  )
    .replace(/^… |…$/gu, "")
    .trim()
    .slice(0, maxSnippetCharacters);
}

function oneLine(value: string) {
  return value.replaceAll(/\s+/gu, " ").trim();
}
