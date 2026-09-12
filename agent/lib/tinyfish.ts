import { asNumber, asRecord, asString } from "./guards.ts";

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";

export const TINYFISH_SEARCH_TIMEOUT_MS = 10_000;
export const TINYFISH_FETCH_TIMEOUT_MS = 25_000;
export const TINYFISH_MAX_FETCH_URLS = 5;
export const TINYFISH_MAX_FETCH_CHARS = 6_000;
export const TINYFISH_FETCH_TTL_SECONDS = 3_600;
export const TINYFISH_DEFAULT_LOCATION = "RU";
export const TINYFISH_MISSING_KEY =
  "TinyFish не настроен: нужен TINYFISH_API_KEY";

export type SearchKind = "web" | "news";

export type SearchHit = {
  position: number;
  title: string;
  url: string;
  snippet: string;
  site?: string;
  date?: string;
};

export type FetchPage = {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
};

export type FetchFailure = {
  url: string;
  error: string;
};

export type TinyfishErr = { error: string };

export type WebFetchFormat = "markdown" | "text" | "html";

export type WebFetchPage = {
  content: string;
  contentType: string;
  truncated: boolean;
  url: string;
};

export function tinyfishKey(): string | undefined {
  const key = process.env.TINYFISH_API_KEY?.trim();
  return key || undefined;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function tinyfishErrorMessage(status: number, body: string): string {
  const rec = asRecord(safeJson(body));
  const err = rec ? asRecord(rec.error) : null;
  const message = err ? asString(err.message) : undefined;
  if (message) return message;
  if (status === 429) return "TinyFish rate limit — подожди секунду и повтори";
  return `TinyFish ${status}`;
}

export function compactSearchHits(raw: unknown): SearchHit[] {
  const rec = asRecord(raw);
  const rows = rec && Array.isArray(rec.results) ? rec.results : [];
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const title = asString(item.title);
    const url = asString(item.url);
    if (!title || !url || !isHttpUrl(url)) continue;
    const snippet = asString(item.snippet) ?? "";
    const site = asString(item.site_name);
    const date = asString(item.date);
    const position = asNumber(item.position) ?? hits.length + 1;
    hits.push({
      position,
      title,
      url,
      snippet,
      ...(site ? { site } : {}),
      ...(date ? { date } : {}),
    });
  }
  return hits;
}

export function compactFetchResult(raw: unknown): {
  pages: FetchPage[];
  errors: FetchFailure[];
} {
  const rec = asRecord(raw);
  const pages: FetchPage[] = [];
  const errors: FetchFailure[] = [];
  const rows = rec && Array.isArray(rec.results) ? rec.results : [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const url = asString(item.url) ?? asString(item.final_url) ?? "";
    const clipped = clipText(asString(item.text) ?? "");
    if (!url || !clipped.text) {
      if (url) errors.push({ url, error: "empty page" });
      continue;
    }
    const title = asString(item.title);
    pages.push({
      url,
      text: clipped.text,
      truncated: clipped.truncated,
      ...(title ? { title } : {}),
    });
  }
  const failed = rec && Array.isArray(rec.errors) ? rec.errors : [];
  for (const row of failed) {
    const item = asRecord(row);
    if (!item) continue;
    const url = asString(item.url);
    const error = asString(item.error) ?? "fetch failed";
    if (url) errors.push({ url, error });
  }
  return { pages, errors };
}

export async function tinyfishSearch(args: {
  query: string;
  purpose?: string;
  kind?: SearchKind;
  location?: string;
}): Promise<{ query: string; results: SearchHit[] } | TinyfishErr> {
  const key = tinyfishKey();
  if (!key) return { error: TINYFISH_MISSING_KEY };
  const query = args.query.trim();
  if (!query) return { error: "нужен query" };

  const url = new URL(SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("location", countryCode(args.location) ?? TINYFISH_DEFAULT_LOCATION);
  if (!args.location?.trim()) url.searchParams.set("language", "ru");
  if (args.purpose?.trim()) url.searchParams.set("purpose", args.purpose.trim());
  if (args.kind === "news") url.searchParams.set("domain_type", "news");

  const res = await tinyfishRequest(url, { method: "GET", key, timeoutMs: TINYFISH_SEARCH_TIMEOUT_MS });
  if ("error" in res) return res;
  return { query, results: compactSearchHits(res.body) };
}

export async function tinyfishFetch(
  urls: string[],
  opts?: { format?: WebFetchFormat; timeoutSeconds?: number },
): Promise<{ pages: FetchPage[]; errors: FetchFailure[] } | TinyfishErr> {
  const key = tinyfishKey();
  if (!key) return { error: TINYFISH_MISSING_KEY };

  const clean: string[] = [];
  for (const raw of urls) {
    const url = raw.trim();
    if (!isHttpUrl(url)) return { error: `не URL: ${raw}` };
    if (!clean.includes(url)) clean.push(url);
    if (clean.length >= TINYFISH_MAX_FETCH_URLS) break;
  }
  if (clean.length === 0) return { error: "нужен хотя бы один http(s) URL" };

  const res = await tinyfishRequest(FETCH_URL, {
    method: "POST",
    key,
    timeoutMs: fetchTimeoutMs(opts?.timeoutSeconds),
    body: JSON.stringify({
      urls: clean,
      format: tinyfishPageFormat(opts?.format),
      ttl: TINYFISH_FETCH_TTL_SECONDS,
    }),
  });
  if ("error" in res) return res;
  return compactFetchResult(res.body);
}

/** eve `web_fetch` shape: one URL in, `{ content, contentType, truncated, url }` out. */
export async function tinyfishFetchPage(args: {
  url: string;
  format?: WebFetchFormat;
  timeout?: number;
}): Promise<WebFetchPage> {
  const format = args.format ?? "markdown";
  const result = await tinyfishFetch([args.url], {
    format,
    timeoutSeconds: args.timeout,
  });
  if ("error" in result) {
    return failPage(args.url, result.error);
  }
  const page = result.pages[0];
  if (!page) {
    return failPage(args.url, result.errors[0]?.error ?? "empty page");
  }
  return {
    content: page.text,
    contentType: contentTypeFor(format),
    truncated: page.truncated,
    url: page.url,
  };
}

async function tinyfishRequest(
  url: string | URL,
  opts: { method: "GET" | "POST"; key: string; timeoutMs: number; body?: string },
): Promise<{ body: unknown } | TinyfishErr> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: {
        "X-API-Key": opts.key,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { error: "TinyFish timeout" };
    }
    return { error: err instanceof Error ? err.message : "TinyFish request failed" };
  }
  const text = await res.text();
  if (!res.ok) return { error: tinyfishErrorMessage(res.status, text) };
  return { body: safeJson(text) ?? {} };
}

function tinyfishPageFormat(format: WebFetchFormat | undefined): "markdown" | "html" {
  return format === "html" ? "html" : "markdown";
}

function contentTypeFor(format: WebFetchFormat): string {
  if (format === "html") return "text/html";
  if (format === "text") return "text/plain";
  return "text/markdown";
}

function fetchTimeoutMs(timeoutSeconds: number | undefined): number {
  const seconds = timeoutSeconds ?? 30;
  if (!Number.isFinite(seconds)) return TINYFISH_FETCH_TIMEOUT_MS;
  return Math.min(120_000, Math.max(1_000, Math.round(seconds * 1000)));
}

function failPage(url: string, content: string): WebFetchPage {
  return { content, contentType: "text/plain", truncated: false, url };
}

function countryCode(value: string | undefined): string | undefined {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? code : undefined;
}

function clipText(value: string): { text: string; truncated: boolean } {
  const text = value.replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= TINYFISH_MAX_FETCH_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, TINYFISH_MAX_FETCH_CHARS).trimEnd()}\n…`,
    truncated: true,
  };
}

function safeJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

