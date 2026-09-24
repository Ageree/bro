import { z } from "zod";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";

const completionsUrl = "https://openrouter.ai/api/v1/chat/completions";
/**
 * One attempt. With the reading model told to write nothing, both engines
 * answered 24 probes of Russian local-business queries in 1.2–7.9 s
 * (typically 2–4 s); two attempts and the pause stay under 20 s.
 */
const attemptTimeoutMs = 9000;
/** The pause before the other engine takes over. */
const retryDelayMs = 500;
const maxResults = 8;
/** Enough of a page excerpt to carry a price, an average bill, hours or an address. */
const maxSnippetCharacters = 500;
const maxSites = 5;

/**
 * The search backends, in the order they are tried. Left to choose, OpenRouter
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

/**
 * OpenRouter returns the pages its `web` plugin read as OpenAI-style
 * `url_citation` annotations, each with an excerpt of the page.
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
});

/** A page the model can cite or read with `web_fetch`. */
export interface WebSearchResult {
  readonly snippet: string;
  readonly title: string;
  readonly url: string;
}

/** A search attempt that failed, and whether the other engine is worth a try. */
class WebSearchError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "WebSearchError";
    this.retryable = retryable;
  }
}

/**
 * Runs one web search through OpenRouter's `web` plugin and returns the pages
 * it found. A timeout, a throttle, a gateway failure or an empty answer hands
 * the query to the fallback engine after a short pause, and its failure is
 * the one thrown. Nothing is retried once `signal` aborts the turn.
 */
export async function searchWeb(
  input: WebSearchInput,
  signal: AbortSignal
): Promise<readonly WebSearchResult[]> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");

  try {
    return await searchOnce(input, primaryEngine, apiKey, signal);
  } catch (error) {
    if (signal.aborted || !worthRetrying(error)) throw error;
  }
  // A turn aborted during the pause fails the fetch below straight away.
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  return await searchOnce(input, fallbackEngine, apiKey, signal);
}

async function searchOnce(
  input: WebSearchInput,
  engine: SearchEngine,
  apiKey: string,
  signal: AbortSignal
) {
  const response = await fetch(completionsUrl, {
    body: JSON.stringify(requestBody(input, engine)),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": applicationOrigin(),
      "X-Title": "Bro",
    },
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new WebSearchError(
      `OpenRouter ${String(response.status)}: ${text.slice(0, 300)}`,
      response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
    );
  }
  const results = readResults(text);
  if (results.length === 0) {
    throw new WebSearchError("nothing was found", true);
  }
  return results;
}

/** Whether another engine could still answer after this failure. */
function worthRetrying(cause: unknown) {
  if (cause instanceof WebSearchError) return cause.retryable;
  // A timeout of this attempt, or fetch failing to reach OpenRouter at all.
  return (
    cause instanceof TypeError ||
    (cause instanceof Error && cause.name === "TimeoutError")
  );
}

/** Cheap model the plugin hands the results to; falls back to the inference default. */
function searchModelId() {
  return env.OPENROUTER_SEARCH_MODEL ?? env.OPENROUTER_MODEL;
}

/** The body OpenRouter's chat completions endpoint receives for one search. */
function requestBody(input: WebSearchInput, engine: SearchEngine) {
  return {
    // The citations carry the pages and their excerpts; nothing the model
    // writes is read. Letting it summarize them cost 2–4 s per search.
    max_tokens: 16,
    messages: [
      { content: "Reply with the single word OK.", role: "system" },
      { content: input.query, role: "user" },
    ],
    model: searchModelId(),
    plugins: [webPlugin(input, engine)],
    // DeepSeek spends roughly 1,600 hidden tokens before its first visible
    // character, which buys nothing here.
    reasoning: { enabled: false },
    temperature: 0,
  };
}

/** The plugin searches with the user message; it has no date filter. */
function webPlugin(input: WebSearchInput, engine: SearchEngine) {
  const plugin = { engine, id: "web", max_results: maxResults };
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

function readResults(text: string): readonly WebSearchResult[] {
  const message = parseCompletion(text).choices?.[0]?.message;
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
    if (results.length === maxResults) break;
  }
  return results;
}

function parseCompletion(text: string) {
  try {
    return responseSchema.parse(JSON.parse(text));
  } catch {
    throw new WebSearchError("OpenRouter returned an unusable body.", true);
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
