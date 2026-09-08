import { readFileSync } from "node:fs";
import {
  TINYFISH_DEFAULT_LOCATION,
  TINYFISH_FETCH_TTL_SECONDS,
  TINYFISH_MAX_FETCH_CHARS,
  TINYFISH_MAX_FETCH_URLS,
  TINYFISH_MISSING_KEY,
  compactFetchResult,
  compactSearchHits,
  isHttpUrl,
  tinyfishErrorMessage,
  tinyfishFetch,
  tinyfishFetchPage,
  tinyfishKey,
  tinyfishSearch,
} from "../agent/lib/tinyfish.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(isHttpUrl("https://cbr.ru/currency_base/daily/"), "https ok");
assert(isHttpUrl("http://example.com"), "http ok");
assert(!isHttpUrl("javascript:alert(1)"), "javascript blocked");
assert(!isHttpUrl("not a url"), "plain text blocked");
assert(!isHttpUrl(""), "empty blocked");

const hits = compactSearchHits({
  query: "курс доллара",
  results: [
    {
      position: 1,
      title: "ЦБ",
      url: "https://cbr.ru/currency_base/daily/",
      snippet: "86,58 ₽",
      site_name: "cbr.ru",
      date: "3 часа назад",
    },
    { position: 2, title: "no url" },
    { position: 3, title: "bad", url: "javascript:alert(1)" },
  ],
});
assert(hits.length === 1, "drops bad search rows");
assert(hits[0]?.site === "cbr.ru", "keeps site");
assert(hits[0]?.date === "3 часа назад", "keeps date");

const fetched = compactFetchResult({
  results: [
    {
      url: "https://docs.tinyfish.ai/search-api",
      title: "Search API",
      text: "Search never draws from your wallet — it's free at any balance, including $0.\n\n\n\nMore.",
    },
    { url: "https://example.com/empty", text: "   " },
  ],
  errors: [{ url: "https://blocked.example", error: "timeout" }],
});
assert(fetched.pages.length === 1, "drops empty pages");
assert(fetched.pages[0]?.title === "Search API", "keeps title");
assert(fetched.pages[0]?.truncated === false, "short page is not truncated");
assert(!fetched.pages[0]?.text.includes("\n\n\n"), "collapses extra blanks");
assert(
  fetched.errors.some((e) => e.url === "https://blocked.example"),
  "keeps provider errors",
);
assert(
  fetched.errors.some((e) => e.url === "https://example.com/empty"),
  "empty page is an error",
);

const long = `${"x".repeat(TINYFISH_MAX_FETCH_CHARS + 80)}`;
const clipped = compactFetchResult({
  results: [{ url: "https://example.com/long", text: long }],
});
assert(
  (clipped.pages[0]?.text.length ?? 0) <= TINYFISH_MAX_FETCH_CHARS + 2,
  "clips long pages",
);
assert(clipped.pages[0]?.text.endsWith("…"), "clip marker");
assert(clipped.pages[0]?.truncated === true, "long page is truncated");

assert(
  tinyfishErrorMessage(
    401,
    JSON.stringify({
      error: { code: "INVALID_API_KEY", message: "Invalid or expired API key" },
    }),
  ) === "Invalid or expired API key",
  "parses TinyFish error body",
);
assert(
  tinyfishErrorMessage(429, "nope") ===
    "TinyFish rate limit — подожди секунду и повтори",
  "429 fallback",
);
assert(tinyfishErrorMessage(500, "") === "TinyFish 500", "status fallback");

const saved = process.env.TINYFISH_API_KEY;
delete process.env.TINYFISH_API_KEY;
assert(!tinyfishKey(), "missing key is empty");
{
  const missingSearch = await tinyfishSearch({ query: "test" });
  assert(
    "error" in missingSearch && missingSearch.error === TINYFISH_MISSING_KEY,
    "search refuses without a key",
  );
  const missingFetch = await tinyfishFetch(["https://example.com"]);
  assert(
    "error" in missingFetch && missingFetch.error === TINYFISH_MISSING_KEY,
    "fetch refuses without a key",
  );
  const missingPage = await tinyfishFetchPage({ url: "https://example.com" });
  assert(missingPage.content === TINYFISH_MISSING_KEY, "eve fetch reports missing key");
  assert(missingPage.contentType === "text/plain", "eve fetch failure is plain text");
  assert(missingPage.truncated === false, "eve fetch failure is not truncated");
  assert(missingPage.url === "https://example.com", "eve fetch keeps the url");
}
if (saved !== undefined) process.env.TINYFISH_API_KEY = saved;

{
  const bad = await tinyfishFetch(["javascript:alert(1)"]);
  assert("error" in bad && bad.error.includes("не URL"), "fetch rejects non-http");
}

const searchTool = readFileSync(
  new URL("../agent/tools/web_search.ts", import.meta.url),
  "utf8",
);
const fetchTool = readFileSync(
  new URL("../agent/tools/web_fetch.ts", import.meta.url),
  "utf8",
);
assert(searchTool.includes("tinyfishSearch"), "web_search uses TinyFish");
assert(fetchTool.includes("tinyfishFetchPage"), "web_fetch uses TinyFish");
assert(fetchTool.includes('from "eve/tools/web_fetch"'), "web_fetch keeps the eve slug and schema");
assert(!searchTool.includes("disableTool"), "web_search is mounted");
assert(!fetchTool.includes("disableTool"), "eve default fetch executor is replaced, not removed");
assert(searchTool.includes("browser_task"), "search steers shops to the browser");
assert(fetchTool.includes("browser_task"), "fetch steers forms to the browser");
assert(!fetchTool.includes("urls:"), "web_fetch stays one url, like eve");
assert(!searchTool.includes("groupPersonalBlock"), "public search is ok in groups");
assert(!fetchTool.includes("groupPersonalBlock"), "public fetch is ok in groups");

const instructions = readFileSync(
  new URL("../agent/instructions.md", import.meta.url),
  "utf8",
);
assert(instructions.includes("`web_search`"), "prompt routes facts to search");
assert(instructions.includes("`web_fetch`"), "prompt routes pages to fetch");
assert(
  !/Web errands go through `browser_task`[^\n]*поиск/.test(instructions),
  "general search is no longer a browser errand",
);

const worker = readFileSync(
  new URL("../agent/subagents/worker/instructions.md", import.meta.url),
  "utf8",
);
assert(worker.includes("`web_search`"), "worker still defers discovery to search");

assert(TINYFISH_DEFAULT_LOCATION === "RU", "RU-first search");
assert(TINYFISH_MAX_FETCH_URLS === 5, "fetch stays small");
assert(TINYFISH_FETCH_TTL_SECONDS === 3_600, "fetch prefers hour-fresh pages");
assert(
  readFileSync(new URL("../agent/lib/tinyfish.ts", import.meta.url), "utf8").includes(
    "ttl: TINYFISH_FETCH_TTL_SECONDS",
  ),
  "fetch sends ttl so TinyFish does not serve any-age cache",
);

if (tinyfishKey()) {
  const live = await tinyfishSearch({
    query: "курс доллара ЦБ сегодня",
    purpose: "ответить человеку в мессенджере",
  });
  if ("error" in live) throw new Error(`live search: ${live.error}`);
  assert(live.results.length > 0, "live search returns hits");
  assert(
    live.results.some((h) => h.url.includes("cbr.ru") || h.snippet.includes("₽")),
    "live RU query stays on-topic",
  );
}

console.log("tinyfish-check ok");
