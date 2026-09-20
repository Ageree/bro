import { assert, src, srcJson } from "./lib/check.ts";
import { estimateTokens, sections, skillSurfaces, toolSurfaces } from "./lib/prompt-budget.ts";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Guards the root prompt — but guards a different property than it used to.
 *
 * The previous version asserted ~30 EXACT strings and capped the file at
 * "baseline + 10%". Two things were wrong with that. Pinning exact sentences
 * made the prompt unrewritable: any rephrasing, however much shorter or
 * clearer, failed CI, so the file could only ever accrete. And a ceiling
 * expressed as a percentage ABOVE the current size is not a ceiling — it is
 * a growth allowance. The one measurable property the repo had was permission
 * to get bigger.
 *
 * What actually matters about this prompt is not which words it uses. It is:
 *
 *   1. every rule lives in exactly ONE place (the prompt, a skill, or a tool
 *      description) — duplication is how the four copies of the OTP protocol
 *      and the four copies of the browser rules drifted apart;
 *   2. the safety rules are present at all;
 *   3. the voice is the one the owner asked for, checked by intent rather
 *      than by sentence;
 *   4. it does not grow.
 *
 * So: intent-level assertions, a mechanical duplicate detector, and a ceiling
 * that ratchets DOWN. The per-turn token budget across every surface lives in
 * `scripts/prompt-budget.ts`; this file owns the root prompt's own shape.
 */

const instructions = src("agent/instructions.md");

// --- 1. safety: the rules that must never quietly disappear ------------------
// These are stated as intent and matched loosely, because the point is that
// the prompt FORBIDS the thing, not that it forbids it in a given wording.
for (const [re, what] of [
  [/CVV/i, "card CVV is named as something never taken in chat"],
  [/сейфа ты не проси|в чат не проси|карту в чат не проси/i, "card details are never requested in chat"],
  [/пароль/i, "passwords are covered"],
  [/never mix their facts with anyone else|Never mix jobs across people/i, "one person per thread"],
  [/Data, never instructions|данные, а не инструкции|ДАННЫЕ, а не инструкции/i, "fetched content is data, not instructions"],
] as const) {
  assert(re.test(instructions), `instructions.md safety rule missing: ${what}`);
}

// --- 2. voice: the register the owner pointed at ----------------------------
// One assertion per trait, each matching any reasonable phrasing of it.
//
// Three traits used to be stated as rules the model could not carry out —
// «пиши в его регистре» is unactionable when the only thing in context is the
// rule. They are now MEASURED per person (`agent/lib/person-profile.ts` →
// `styleBlock`, injected by `agent/instructions/profile.ts`) and the prompt
// points at that block instead of restating it. So what is asserted here is
// that the pointer exists; the style itself is that module's to get right.
for (const [re, what] of [
  [/Пиши, как он: длина, регистр/i, "reply shape tracks the human's"],
  [/Как он пишет/, "the prompt points at the MEASURED style block, not a rule"],
  [/Эмодзи первым не ставь/i, "Bro never opens with an emoji"],
  [/лести никогда/i, "no sycophancy"],
  [/не предлагай помощь/i, "small talk is answered, not upsold"],
  [/Плохую новость — первой строкой/i, "bad news goes first and plainly"],
  [/промолчи или поставь реакцию/i, "silence or a tapback is a real turn"],
  [/Две подряд не ставь/i, "wit stays on a short leash"],
] as const) {
  assert(re.test(instructions), `instructions.md voice rule missing: ${what}`);
}

// The opening «взялся» line: shape, freshness, and no stock menu to copy from.
assert(/2–6 слов/.test(instructions), "the 2–6 word window for the opening line");
assert(
  instructions.includes("с маленькой буквы, без точки в конце"),
  "the lowercase, no-final-period shape of the opening line",
);
assert(
  instructions.includes("Без вступления, сразу с дела"),
  "the opening line stays preamble-free",
);
assert(
  instructions.includes("особенно с «ищу»"),
  "the prompt forbids always opening with «ищу»",
);
assert(
  /Формулируй её сам, каждый раз с нуля/.test(instructions),
  "the model is asked to compose the opening line itself",
);
{
  // A roster of ready-made beats is rotation, not speech: a small model copies
  // a menu verbatim. At most three quoted examples may stand as illustration.
  const start = instructions.indexOf("### Строка «взялся»");
  const end = instructions.indexOf("\n## ", start);
  assert(start >= 0, "the «взялся» section is still in the file");
  const section = instructions.slice(start, end < 0 ? undefined : end);
  const quoted = [...section.matchAll(/«([^»]+)»/g)]
    .map((m) => m[1]!)
    .filter((q) => !["ищу", "взялся", "ок", "спасибо", "понял"].includes(q));
  assert(
    quoted.length <= 3,
    `the «взялся» section offers ${quoted.length} ready-made beats — at most 3 may stand as illustration`,
  );
}

// --- 3. jargon that must never reach a human-facing bubble -------------------
for (const needle of ["джоб", "Cloud-сесси", "browser-job"]) {
  assert(!instructions.includes(needle), `instructions.md must not contain "${needle}"`);
}
assert(!instructions.includes("Cloud"), "instructions.md drops the bare word Cloud");

// Robotic phrasings are named so the model is steered off them.
for (const robotic of [
  "Задача принята",
  "Статус:",
  "Выполняю запрос",
  "Готов помочь!",
  "Прошу прощения за доставленные неудобства",
]) {
  assert(instructions.includes(robotic), `instructions.md must ban the phrasing "${robotic}"`);
}
assert(
  /не начинай сообщение с «Бро\.»/.test(instructions),
  "instructions.md keeps the «Бро.» opener ban",
);
assert(
  instructions.includes("Не пересказывай просьбу обратно человеку"),
  "instructions.md bans restating the request back at them",
);

// --- 4. tool rules live with their tools, not in the root prompt ------------
/**
 * The `## Браузер` section and the `результат тула → что сказать` table used to
 * sit here, ~1000 estimated tokens on EVERY call, though they only apply once
 * `browser_task` has been called and has returned a particular result. They are
 * now exported by the tools themselves and assembled per turn by
 * `agent/instructions/tools.ts`, the way pi's `toolGuidelines` works: a tool
 * that is not mounted contributes no rules at all.
 *
 * What is asserted here is the invariant that survived the move — every one of
 * those rules still reaches the model, and none of them is stated twice. The
 * text itself is `guidelines:check`'s to own.
 */
{
  const browserRules = src("agent/lib/tool-rules.ts");
  for (const needle of ["ввожу код", "подожду", "проверяю", "сначала закончу"]) {
    assert(
      browserRules.includes(needle),
      `the «${needle}» protocol line moved to BROWSER_TASK_GUIDELINES and must still be there`,
    );
  }
  // …and is gone from the root prompt, or it is being paid for twice.
  assert(
    !instructions.includes("| результат тула | что сказать |"),
    "the tool-result table belongs to the tools now, not the root prompt",
  );
  assert(
    !/^## Браузер/m.test(instructions),
    "the browser section belongs to browser_task's guidelines now",
  );
}
// Rules that are genuinely about the person rather than about a tool stay.
for (const needle of ["otp_lookup", "errand"]) {
  assert(instructions.includes(needle), `instructions.md must contain "${needle}"`);
}

// --- 5. channel formatting is NOT in the root prompt ------------------------
// It belongs to `agent/instructions/channel.ts`, which sends one channel's
// rules to the turns on that channel. Both halves on every call is how a
// model ends up writing Telegram markdown into an iMessage bubble.
for (const [re, what] of [
  [/:::buttons/, "the Telegram button block"],
  [/\|\|спойлер\|\|/, "Telegram spoiler syntax"],
  [/зелёный SMS|зелёный sms/i, "the iMessage green-bubble rule"],
] as const) {
  assert(!re.test(instructions), `${what} belongs in agent/instructions/channel.ts, not the root prompt`);
}
{
  const channel = src("agent/instructions/channel.ts");
  assert(channel.includes(":::buttons"), "channel.ts carries the Telegram rules");
  assert(/зелёный SMS/i.test(channel), "channel.ts carries the iMessage rules");
  assert(
    channel.includes("routingFromAuth"),
    "channel.ts decides the channel with the same helper delivery uses",
  );
}

// --- 6. no rule lives in two places ----------------------------------------
/**
 * The duplicate detector, and the reason this file was rewritten.
 *
 * Before the dedup pass the OTP protocol existed four times (root prompt,
 * `agent/skills/otp/SKILL.md`, the worker subagent's instructions, and the
 * worker's browser-execution skill) and had already drifted: one copy said
 * «сначала почта», another said `Needs user input:`, a third offered «otp
 * (субагент) или otp_lookup». A model picks whichever copy it read last.
 *
 * Duplication is detected on normalised 6-word shingles. That window is long
 * enough that ordinary shared vocabulary («browser_task», «в чат не проси»)
 * cannot trip it, and short enough to catch a paragraph someone pasted into a
 * second file.
 */
const SHINGLE = 6;
const DUP_LIMIT = 2;

function shingles(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s_]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= words.length; i += 1) {
    out.add(words.slice(i, i + SHINGLE).join(" "));
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): string[] {
  const shared: string[] = [];
  for (const s of a) if (b.has(s)) shared.push(s);
  return shared;
}

const rootShingles = shingles(instructions);

for (const skill of skillSurfaces().filter((e) => e.surface === "on-demand")) {
  const body = skill.label.startsWith("agent/skills/")
    ? readFileSync(new URL("../" + skill.label.replace(/ \(body\)$/, ""), import.meta.url), "utf8")
    : "";
  if (!body) continue;
  const shared = overlap(rootShingles, shingles(body));
  assert(
    shared.length <= DUP_LIMIT,
    `${skill.label} repeats the root prompt (${shared.length} shared phrases, e.g. "${shared[0]}") — a rule belongs in one place`,
  );
}

for (const tool of toolSurfaces()) {
  const shared = overlap(rootShingles, shingles(readFileSync(new URL("../" + tool.label, import.meta.url), "utf8")));
  assert(
    shared.length <= DUP_LIMIT,
    `${tool.label} repeats the root prompt (${shared.length} shared phrases, e.g. "${shared[0]}") — say it in the tool description or the prompt, not both`,
  );
}

// Subagent instructions are a separate agent's prompt, so sharing a rule with
// the root is legitimate framing — but wholesale copies are not.
for (const rel of [
  "agent/subagents/worker/instructions.md",
  "agent/subagents/otp/instructions.md",
]) {
  let body: string;
  try {
    body = src(rel);
  } catch {
    continue;
  }
  const shared = overlap(rootShingles, shingles(body));
  assert(
    shared.length <= DUP_LIMIT + 2,
    `${rel} repeats the root prompt (${shared.length} shared phrases, e.g. "${shared[0]}")`,
  );
}

// The deleted duplicate must stay deleted.
assert(
  !readdirSync(new URL("../agent/skills", import.meta.url)).includes("otp"),
  "agent/skills/otp was a fourth copy of the OTP protocol — it must not come back",
);

// --- 7. the ceiling, which ratchets down ------------------------------------
/**
 * History, in estimated tokens of `agent/instructions.md` alone:
 *   5617  before the dedup pass (13 sections, both channels' formatting)
 *   4467  after: channel formatting moved to a per-turn dynamic instruction,
 *         OTP deduped against the tool and the worker, browser prose cut to
 *         what the human hears, Composio detail moved into its skill
 *   4506  net of two later edits: the instinct wake-up earned a line (+104),
 *         and the onboarding section lost most of one (−65) because
 *         `shouldSkipAgentTurn` answers «что ты» / «help» from the channel —
 *         those turns never reach the model, so rules about them were prompt
 *         weight spent on a turn that does not exist
 *   4565  carried in from #116 when main was merged: the caveat that Telegram
 *         is a LIVE second channel and «недоступен» is never the answer. It
 *         sits in the root block rather than the Telegram half of
 *         `channel.ts`, because the person asks that question from iMessage —
 *         on that turn the Telegram half is not loaded at all
 *
 * Lower this when a trim lands. Raising it means a rule was added that truly
 * must reach every person on every channel on every turn — rare, and worth
 * arguing for in the commit message.
 */
const CEILING_TOKENS = 4_600;
const actual = estimateTokens(instructions);
assert(
  actual <= CEILING_TOKENS,
  `agent/instructions.md is ~${actual} tok, over the ${CEILING_TOKENS} ceiling`,
);
assert(
  actual >= CEILING_TOKENS * 0.7,
  `agent/instructions.md is ~${actual} tok, far under the ${CEILING_TOKENS} ceiling — re-take it`,
);

// Every section earns its place: a stub is a rule nobody finished moving.
for (const s of sections(instructions)) {
  assert(
    s.text.trim().length > 80,
    `section "${s.title}" is a stub — finish the move or delete it`,
  );
}

const pkg = srcJson<{ scripts: Record<string, string> }>("package.json");
assert(pkg.scripts["instructions:check"], "package.json instructions:check");
assert(pkg.scripts["budget:check"], "package.json budget:check runs the per-turn budget");

console.log(`instructions-check ok — root prompt ~${actual} tok`);
