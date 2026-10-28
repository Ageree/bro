import * as z from "zod";
import { env } from "@shared/environment";

/**
 * Exa's search API called directly with the owner's key: $10 a month free, then about $0.004–0.007 a
 * search of eight pages (exa.ai/pricing), against ≈2.2 ₽ for the same engine through RouterAI's web plugin.
 * Through RouterAI its index scored 28 of 30 on Russian queries (`docs/benchmarks/web-search.md`); through
 * Composio's Instant it returned no excerpts, so `highlights` are asked for here.
 */
const searchUrl = "https://api.exa.ai/search";
const attemptTimeoutMs = 5000;

const answerSchema = z.object({
  results: z
    .array(
      z.object({
        highlights: z.array(z.string()).nullish(),
        publishedDate: z.string().nullish(),
        title: z.string().nullish(),
        url: z.string(),
      })
    )
    .nullish(),
});

/** What Exa's search takes of all it could: eight pages with their highlights. */
interface ExaRequest {
  readonly contents: { readonly highlights: true };
  includeDomains?: readonly string[];
  readonly numResults: number;
  readonly query: string;
  readonly type: "fast";
  userLocation?: "RU";
}

/** A failed Exa search, its status kept: 402 and 429 mean the key's allowance, not the query. */
export class ExaSearchError extends Error {
  override readonly name = "ExaSearchError";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function exaConfigured() {
  return env.EXA_API_KEY !== undefined;
}

/** «2026-10-27T08:00:00.000Z» as the day it names. */
function day(published: string | null | undefined) {
  return published?.slice(0, 10) ?? "";
}

/** One search; its pages as found, excerpt in `content`. */
export async function searchExa(
  query: string,
  domains: readonly string[],
  pages: number,
  signal: AbortSignal
) {
  const key = env.EXA_API_KEY;
  if (key === undefined) throw new ExaSearchError("No Exa key");
  const request: ExaRequest = {
    contents: { highlights: true },
    numResults: pages,
    query,
    type: "fast",
  };
  if (/\p{Script=Cyrillic}/u.test(query)) request.userLocation = "RU";
  if (domains.length > 0) request.includeDomains = domains;
  const response = await fetch(searchUrl, {
    body: JSON.stringify(request),
    headers: { "content-type": "application/json", "x-api-key": key },
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]),
  });
  if (!response.ok)
    throw new ExaSearchError(
      `Exa answered ${String(response.status)}`,
      response.status
    );
  const answer = answerSchema.safeParse(await response.json());
  if (!answer.success)
    throw new ExaSearchError("Exa answered an unknown shape");
  const found = (answer.data.results ?? []).map((page) => ({
    content: (page.highlights ?? []).join(" … "),
    date: day(page.publishedDate),
    title: page.title ?? "",
    url: page.url,
  }));
  if (found.length === 0) throw new ExaSearchError("Exa found nothing");
  return found;
}
