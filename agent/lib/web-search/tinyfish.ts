import * as z from "zod";
import { env } from "@shared/environment";

/**
 * TinyFish's own search API, the engine Composio's `TINYFISH_SEARCH_WEB` wraps: free with the owner's key
 * (search is $0 on every tier; 30 requests a minute, docs.tinyfish.ai/search-api/reference), where
 * Composio billed each call to its wallet and refused all of them once it ran dry (28.10). Same arguments:
 * a Cyrillic query is searched in Russian from Russia, domains as one comma-separated value.
 */
const searchUrl = "https://api.search.tinyfish.ai";
const attemptTimeoutMs = 5000;

const answerSchema = z.object({
  results: z
    .array(
      z.object({
        date: z.string().nullish(),
        snippet: z.string().nullish(),
        title: z.string().nullish(),
        url: z.string(),
      })
    )
    .nullish(),
});

/** A failed TinyFish search, its status kept: 402 and 429 mean the key's allowance, not the query. */
export class TinyFishSearchError extends Error {
  override readonly name = "TinyFishSearchError";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function tinyFishConfigured() {
  return env.TINYFISH_API_KEY !== undefined;
}

/** One search; its pages as found, excerpt in `content`. */
export async function searchTinyFish(
  query: string,
  domains: readonly string[],
  signal: AbortSignal
) {
  const key = env.TINYFISH_API_KEY;
  if (key === undefined) throw new TinyFishSearchError("No TinyFish key");
  const url = new URL(searchUrl);
  url.searchParams.set("query", query);
  if (/\p{Script=Cyrillic}/u.test(query)) {
    url.searchParams.set("language", "ru");
    url.searchParams.set("location", "RU");
  }
  if (domains.length > 0)
    url.searchParams.set("include_domains", domains.join(","));
  const response = await fetch(url, {
    headers: { "X-API-Key": key },
    signal: AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]),
  });
  if (!response.ok)
    throw new TinyFishSearchError(
      `TinyFish answered ${String(response.status)}`,
      response.status
    );
  const answer = answerSchema.safeParse(await response.json());
  if (!answer.success)
    throw new TinyFishSearchError("TinyFish answered an unknown shape");
  const found = (answer.data.results ?? []).map((page) => ({
    content: page.snippet ?? "",
    date: page.date ?? "",
    title: page.title ?? "",
    url: page.url,
  }));
  if (found.length === 0)
    throw new TinyFishSearchError("TinyFish found nothing");
  return found;
}
