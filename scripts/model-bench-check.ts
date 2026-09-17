/**
 * Grader regression for `scripts/model-bench.ts`.
 *
 * A benchmark that mis-grades a correct answer is worse than no benchmark: it
 * spends money to produce a confident wrong ranking. These cases are the
 * shapes real browser agents actually emit — bold markdown, a currency symbol
 * after the colon, a prose sentence wrapped around the answer line.
 */
import { grade, readNum, TASKS, V4_MODELS } from "./model-bench.ts";

let failed = 0;
function assert(cond: boolean, what: string): void {
  if (cond) console.log(`  ok   ${what}`);
  else { console.error(`  FAIL ${what}`); failed++; }
}

const books = TASKS.find((t) => t.id === "books-travel-agg")!;
const quotes = TASKS.find((t) => t.id === "quotes-paginate")!;
const tables = TASKS.find((t) => t.id === "tables-due")!;

console.log("number parsing");
assert(readNum("COUNT=3 SUM=132.39", "SUM") === 132.39, "plain");
assert(readNum("**COUNT = 3** SUM: £132.39", "SUM") === 132.39, "bold + currency after colon");
assert(readNum("SUM $1,234.50", "SUM") === 1234.5, "thousands separator, no separator char");
assert(readNum("TOTAL=100", "COUNT") === null, "absent label is null, not 0");

console.log("full-credit answers");
for (const [label, ans] of [
  ["exact", "COUNT=3 SUM=132.39"],
  ["bold + currency", "**COUNT = 3** **SUM = £132.39**"],
  ["prose wrapper", "I checked the Travel category. COUNT: 3 SUM: £132.39"],
] as const) {
  const g = grade(ans, books.expect);
  assert(g.hits === g.total, `books ${label} -> ${g.hits}/${g.total}`);
}
assert(grade("TOTAL=100 AUTHOR=Albert Einstein COUNT=10", quotes.expect).hits === 3, "quotes exact");
assert(grade("**TOTAL:** 100, **AUTHOR:** Albert  Einstein, **COUNT:** 10", quotes.expect).hits === 3, "quotes messy");
assert(grade("SUM=251.00 TOP=Jason Doe", tables.expect).hits === 2, "tables exact");
assert(grade("SUM: $251.00 TOP: Doe, Jason", tables.expect).hits === 2, "tables reversed name");

console.log("wrong answers must not score");
assert(grade("COUNT=11 SUM=286.51", books.expect).hits === 0, "whole category instead of 4+ stars");
assert(grade("COUNT=3 SUM=132.40", books.expect).hits === 1, "penny off fails SUM, keeps COUNT");
assert(grade("TOTAL=10 AUTHOR=Albert Einstein COUNT=3", quotes.expect).hits === 1, "first page only");
assert(grade("", books.expect).hits === 0, "empty result scores zero");
assert(grade("I could not complete this task.", tables.expect).hits === 0, "refusal scores zero");

console.log("model allowlist");
assert(!V4_MODELS.has("jev"), "jev is not a Browser Use model");
assert(!V4_MODELS.has("deepseek/deepseek-v4.1-flash"), "OpenRouter id is not a cloud model id");
assert(V4_MODELS.has("gpt-5.6-luna") && V4_MODELS.has("deepseek-v4-flash-vision"), "real ids accepted");

console.log(failed ? `\n${failed} failed` : "\nmodel-bench grader ok");
if (failed) process.exit(1);
