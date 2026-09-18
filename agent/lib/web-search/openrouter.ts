import { z } from "zod";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";

const completionsUrl = "https://openrouter.ai/api/v1/chat/completions";
const requestTimeoutMs = 15_000;
const maxResults = 8;
const maxSnippetCharacters = 220;

export const webSearchInputSchema = z.object({
  query: z.string().min(1).describe("What to search the web for."),
  recency: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe(
      "Prefer pages published within this window. Omit unless freshness matters."
    ),
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

/**
 * OpenRouter returns the pages its `web` plugin read as OpenAI-style
 * `url_citation` annotations. The model's own text is the fallback for a
 * provider that answered without them.
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
            content: z.string().nullable().optional(),
          })
          .optional(),
      })
    )
    .optional(),
});

const candidatesSchema = z.array(
  z.object({
    snippet: z.string().optional(),
    title: z.string().optional(),
    url: z.string(),
  })
);

/** One page the search turned up, before it is trimmed for the model. */
type WebSearchCandidate = z.infer<typeof candidatesSchema>[number];

/** A page the model can cite or read with `web_fetch`. */
export interface WebSearchResult {
  readonly snippet: string;
  readonly title: string;
  readonly url: string;
}

/** An OpenRouter reply that was not a 2xx, with enough of the body to act on. */
class WebSearchError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`OpenRouter ${String(status)}: ${body.slice(0, 300)}`);
    this.name = "WebSearchError";
    this.status = status;
  }
}

/**
 * Runs one web search through OpenRouter's `web` plugin and returns the pages
 * it found. Throws when the key is missing, the request fails twice, or the
 * reply carries neither citations nor a parseable JSON array.
 */
export async function searchWeb(
  input: WebSearchInput
): Promise<readonly WebSearchResult[]> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");

  const init: RequestInit = {
    body: JSON.stringify(requestBody(input)),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": applicationOrigin(),
      "X-Title": "OpenInstinct",
    },
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMs),
  };

  let response = await fetch(completionsUrl, init);
  // One retry only. A second throttle or gateway failure means the model should
  // hear about it rather than queue more load onto the same search.
  if (response.status === 429 || response.status >= 500) {
    response = await fetch(completionsUrl, {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  }

  const text = await response.text();
  if (!response.ok) throw new WebSearchError(response.status, text);

  const results = readResults(text);
  if (results.length === 0) throw new Error("OpenRouter returned no results.");
  return results;
}

/** Cheap model that reads the plugin's results; falls back to the inference default. */
function searchModelId() {
  return env.OPENROUTER_SEARCH_MODEL ?? env.OPENROUTER_MODEL;
}

function searchInstruction(recency: WebSearchInput["recency"]) {
  const window = recency
    ? ` Prefer pages published within the last ${recency}.`
    : "";
  return (
    [
      "You summarize web search results.",
      `Reply with JSON only: an array of at most ${String(maxResults)} objects`,
      'with the keys "title", "url", and "snippet".',
      "The snippet is one factual line drawn from the page.",
      "Never invent a URL and never add prose around the array.",
    ].join(" ") + window
  );
}

/** The body OpenRouter's chat completions endpoint receives for one search. */
function requestBody(input: WebSearchInput) {
  return {
    // The citations carry the pages; the model only has to name and summarize
    // them. Capping its reply keeps a search inside the 15 s budget.
    max_tokens: 700,
    messages: [
      { content: searchInstruction(input.recency), role: "system" },
      { content: input.query, role: "user" },
    ],
    model: searchModelId(),
    // The plugin runs the search server-side and feeds the pages to the model as
    // context. `max_results` is the only knob it accepts here and it has no date
    // filter, so recency travels in the instruction instead.
    plugins: [{ id: "web", max_results: maxResults }],
    // DeepSeek spends roughly 1,600 hidden tokens before its first visible
    // character, which buys nothing for a list of links.
    reasoning: { enabled: false },
    temperature: 0,
  };
}

function readResults(text: string): readonly WebSearchResult[] {
  const message = parseCompletion(text).choices?.[0]?.message;
  const cited: WebSearchCandidate[] = [];
  for (const annotation of message?.annotations ?? []) {
    const citation =
      annotation.type === "url_citation" ? annotation.url_citation : undefined;
    if (citation) {
      cited.push({
        snippet: citation.content,
        title: citation.title,
        url: citation.url,
      });
    }
  }
  return cited.length > 0
    ? trim(cited)
    : trim(readCandidatesFromText(message?.content ?? ""));
}

function parseCompletion(text: string) {
  try {
    return responseSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("OpenRouter returned an unusable body.");
  }
}

function readCandidatesFromText(
  content: string
): readonly WebSearchCandidate[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    return candidatesSchema.parse(JSON.parse(content.slice(start, end + 1)));
  } catch {
    return [];
  }
}

function trim(
  candidates: readonly WebSearchCandidate[]
): readonly WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const candidate of candidates) {
    const url = z.url().safeParse(candidate.url.trim());
    if (!url.success || seen.has(url.data)) continue;
    seen.add(url.data);
    results.push({
      snippet: oneLine(candidate.snippet ?? "").slice(0, maxSnippetCharacters),
      title: oneLine(candidate.title ?? "") || url.data,
      url: url.data,
    });
    if (results.length === maxResults) break;
  }
  return results;
}

function oneLine(value: string) {
  return value.replaceAll(/\s+/gu, " ").trim();
}
