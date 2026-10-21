import { z } from "zod";
import { composioConfigured, composioRequest } from "@shared/composio/api";
import { env } from "@shared/environment";

/**
 * The search engines Composio Instant runs on its own provider accounts, in
 * the order they are tried, and its user for them: one with no connected
 * accounts, so a call never runs on a person's own connection. Probe of
 * 14.10 (10 Russian queries, blind judges, 0–3 each, of 30): Bro's search
 * through RouterAI 28–29 at 2.22 ₽ a search; Tavily 27 at $0.008; TinyFish
 * 24 with short excerpts and no charge; Exa through Instant 13, since
 * Composio's managed Exa returns no excerpts. TinyFish leads because the
 * owner chose a free search; Tavily takes over when it fails.
 */
export const instantEngines = ["tinyfish", "tavily"] as const;

export type InstantEngine = (typeof instantEngines)[number];

const instantUserId = "bro-web-search";

/**
 * One attempt. Direct execution answered in 0.8–1.1 s on 14.10, through a
 * Composio session 1.9–6 s; the RouterAI engines after these still fit the
 * turn.
 */
const attemptTimeoutMs = 6000;

/** Whether searches go to Composio Instant before RouterAI's engines. */
export function instantSearchEnabled() {
  return composioConfigured() && env.WEB_SEARCH_INSTANT === "on";
}

const pageSchema = z.object({
  content: z.string().nullish(),
  // TinyFish's own dating of the page, as the engine printed it: «8 часов
  // назад», «21 сент. 2026 г.», «2 hours ago»; null when it shows none.
  // Tavily's basic search has no such field (probes of 21.10).
  date: z.string().nullish(),
  snippet: z.string().nullish(),
  title: z.string().nullish(),
  url: z.string(),
});

/**
 * Composio answers a tool's own failure (the engine's limit, a bad argument)
 * with HTTP 200, `successful: false` and the engine's words in `error`.
 */
const executionSchema = z.object({
  data: z
    .object({ results: z.array(pageSchema).nullish() })
    .nullish()
    .catch(undefined),
  error: z.string().nullish(),
  successful: z.boolean(),
});

/** A failed Instant search: the engine refused, or found nothing. */
export class InstantSearchError extends Error {
  override readonly name = "InstantSearchError";
}

/**
 * Runs one search on one Instant engine and returns its pages as found,
 * excerpt in `content`, the engine's date for the page in `date`. Composio's
 * own refusals (an empty balance is 402 `Metering_WalletBalanceExhausted`)
 * throw its `ComposioError`.
 */
export async function searchInstant(
  engine: InstantEngine,
  query: string,
  domains: readonly string[],
  pages: number,
  signal: AbortSignal
) {
  const slug = engine === "tinyfish" ? "TINYFISH_SEARCH_WEB" : "TAVILY_SEARCH";
  const execution = await composioRequest(
    executionSchema,
    `/tools/execute/${slug}`,
    {
      body: {
        arguments: instantArguments(engine, query, domains, pages),
        user_id: instantUserId,
      },
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]),
    }
  );
  if (!execution.successful) {
    throw new InstantSearchError(
      `${engine} refused: ${(execution.error ?? "no reason").slice(0, 200)}`
    );
  }
  const found = (execution.data?.results ?? []).map((page) => ({
    content: page.content ?? page.snippet ?? "",
    date: page.date ?? "",
    title: page.title ?? "",
    url: page.url,
  }));
  if (found.length === 0) {
    throw new InstantSearchError(`${engine} found nothing`);
  }
  return found;
}

/**
 * TinyFish answers in English from the US unless told otherwise; a query in
 * Cyrillic is searched in Russian from Russia.
 */
function instantArguments(
  engine: InstantEngine,
  query: string,
  domains: readonly string[],
  pages: number
) {
  const included = domains.length > 0 ? { include_domains: domains } : {};
  if (engine === "tavily") {
    return { max_results: pages, query, search_depth: "basic", ...included };
  }
  const russian = /\p{Script=Cyrillic}/u.test(query)
    ? { language: "ru", location: "RU" }
    : {};
  return { query, ...russian, ...included };
}
