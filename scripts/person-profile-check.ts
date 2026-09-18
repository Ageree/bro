// Pure-logic assertions for the person profile block
// (agent/lib/person-profile.ts) and the dynamic inject that carries it
// (agent/instructions/profile.ts).
//
// No network, no Convex: every function under test is pure, which is the whole
// reason the measured half of the block was built this way. The inject is
// checked from source, the way scripts/jobs-check.ts checks jobs.ts.
//
// What this file really guards is the inversion the block exists for. The
// system prompt used to spend ~1200 tokens of §Voice on RULES about how to
// talk («пиши в его регистре») and nothing at all on who is being talked to —
// and «пиши в его регистре» names a variable the prompt never binds, which the
// model this agent runs (deepseek-v4.1-flash, reasoning off) cannot resolve on
// its own. So: the block must state FACTS (asserted below, imperatives banned),
// it must never state a fact it cannot support (the sample thresholds), it must
// fit its budget by dropping whole facts (the trim order), and it must not leak
// a secret on the way (scrubSecrets, last net).

import {
  MIN_STYLE_SAMPLES,
  PERSON_PROFILE_MAX_TOKENS,
  STYLE_SAMPLE_WINDOW,
  factsBlock,
  measureStyle,
  personProfile,
  styleBlock,
  styleSamplesFromMessages,
  type PersonFacts,
  type StyleSample,
  type WritingStyle,
} from "../agent/lib/person-profile.ts";
import { estimateTokens } from "./lib/prompt-budget.ts";
import { assert, eq, src } from "./lib/check.ts";

const samples = (...texts: string[]): StyleSample[] => texts.map((text) => ({ text }));

// ---------------------------------------------------------------------------
// measureStyle — a claim about a person needs evidence
// ---------------------------------------------------------------------------

eq(measureStyle([]), null, "no samples → no claim");
eq(measureStyle(samples("ок")), null, "one sample → no claim");
eq(measureStyle(samples("ок", "го")), null, "two samples → no claim");
assert(MIN_STYLE_SAMPLES === 3, "threshold is three written samples");

const lower = measureStyle(samples("ок", "го давай", "сколько стоит"));
assert(lower !== null, "three written samples are enough");
eq(lower.lowercase, true, "all-lowercase openings read as lowercase");
eq(lower.endsPunctuation, false, "no full stops read as unpunctuated");
eq(lower.usesEmoji, false, "no emoji in the samples");
eq(lower.recentEmoji.length, 0, "no emoji collected");
assert(lower.avgWords > 1 && lower.avgWords < 2, `avg words: ${lower.avgWords}`);

const upper = measureStyle(samples("Привет.", "Купи молока.", "Хорошо, спасибо."));
assert(upper !== null, "capitalised samples still measure");
eq(upper.lowercase, false, "capitalised openings do not read as lowercase");
eq(upper.endsPunctuation, true, "full stops read as punctuated");

// A genuinely mixed writer has no register to report, and the block states its
// findings as fact — so it says nothing rather than picking a side.
eq(
  measureStyle(samples("ок", "Привет.", "го", "Купи молока.")),
  null,
  "no 2/3 majority → no claim",
);

// A question mark is a question, not a punctuation habit: people who never
// type a full stop still type «сколько стоит?».
const asker = measureStyle(samples("сколько стоит?", "когда приедет?", "а дешевле есть?"));
assert(asker !== null, "question-only samples still measure");
eq(asker.endsPunctuation, false, "trailing ? is not a full stop habit");

// --- service lines are not the person speaking -----------------------------

const withService = measureStyle(
  samples(
    "[button] confirm_order",
    "[event:mail] Письмо от Ozon. Ваш заказ отправлен.",
    "[background wakeup] Фоновая проверка джоба: заказ.",
    "ок",
    "го",
    "давай",
  ),
);
assert(withService !== null, "service lines do not block a measurement");
eq(withService.lowercase, true, "service lines do not vote on register");
eq(withService.endsPunctuation, false, "a wakeup prompt's full stops are not his");

eq(
  measureStyle(samples("[button] x", "[event:mail] y", "ок", "го")),
  null,
  "service lines do not count toward the sample threshold",
);

// --- [voice] is his words but not his typing -------------------------------
//
// Three lowercase unpunctuated written lines plus three transcripts that the
// transcriber capitalised and punctuated. If voice voted on register the
// majority would be 3:3 — no majority, null. Getting `lowercase: true` back is
// the proof that it does not vote.
const withVoice = measureStyle(
  samples(
    "ок",
    "го",
    "давай",
    "[voice] Купи молока.",
    "[voice] Забери посылку завтра.",
    "[voice] Позвони маме.",
  ),
);
assert(withVoice !== null, "voice lines do not break a measurement");
eq(withVoice.lowercase, true, "voice transcripts do not vote on register");
eq(withVoice.endsPunctuation, false, "the transcriber's full stops are not his");
// ...but they DO count as messages he sent, so the average length moves.
assert(
  withVoice.avgWords > 1.2,
  `voice counts toward length: ${withVoice.avgWords}`,
);

// --- emoji -----------------------------------------------------------------

const emoji = measureStyle(samples("привет 🔥", "го 😂", "ща 🔥"));
assert(emoji !== null, "emoji samples measure");
eq(emoji.usesEmoji, true, "emoji detected");
eq(emoji.recentEmoji.join(" "), "🔥 😂", "recent emoji, newest first, deduped");
eq(emoji.endsPunctuation, false, "a trailing emoji is not punctuation");

const family = measureStyle(samples("это мы 👨‍👩‍👧", "го", "ща"));
assert(family !== null, "zwj sample measures");
eq(family.recentEmoji.join(""), "👨‍👩‍👧", "a ZWJ sequence counts as one emoji");

// --- the reader over an eve history ---------------------------------------

const history = styleSamplesFromMessages([
  { role: "user", content: "ок" },
  { role: "assistant", content: "Взялся." },
  { role: "user", content: [{ type: "text", text: "го" }] },
  { role: "tool", content: "{}" },
  { role: "user", content: "давай" },
]);
eq(history.length, 3, "only user-role lines are sampled");
eq(history.map((s) => s.text).join(","), "ок,го,давай", "chronological order kept");
eq(styleSamplesFromMessages(undefined).length, 0, "no history → no samples");
eq(styleSamplesFromMessages([null, 7, "x"]).length, 0, "garbage history → no samples");
eq(
  styleSamplesFromMessages(
    Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `строка ${i}` })),
  ).length,
  STYLE_SAMPLE_WINDOW,
  "only the trailing window is measured",
);

// ---------------------------------------------------------------------------
// styleBlock — facts, never orders
// ---------------------------------------------------------------------------

// JS `\b` is ASCII-only, so Cyrillic word boundaries need explicit lookarounds
// (same trick convex/lib/secretScrub.ts uses).
const IMPERATIVE = /(?<![\p{L}])(пиши|ставь|используй|повторяй|отвечай|копируй)(?![\p{L}])/iu;

for (const style of [lower, upper, emoji] as WritingStyle[]) {
  const text = styleBlock(style);
  assert(text.length > 0, "style block is never empty");
  assert(!IMPERATIVE.test(text), `style block must not give orders: ${text}`);
  assert(!text.includes("не пиши"), "style block must not forbid anything");
  assert(text.split("\n").length <= 2, `style block is 1-2 lines: ${text}`);
}

assert(
  styleBlock(lower).includes("с маленькой буквы"),
  "lowercase habit is stated",
);
assert(styleBlock(upper).includes("с точками"), "punctuation habit is stated");
assert(styleBlock(emoji).includes("🔥"), "spent emoji are shown, not described");
assert(
  styleBlock(lower).includes("эмодзи не ставит"),
  "the absence of emoji is a fact worth stating",
);

// Russian plurals, because «в среднем 4 слов» reads like machine output and
// this block's entire job is to not read like machine output.
const withWords = (n: number): string =>
  styleBlock({ ...lower, avgWords: n });
assert(withWords(1).includes("1 слово"), "1 слово");
assert(withWords(4).includes("4 слова"), "4 слова");
assert(withWords(7).includes("7 слов"), "7 слов");
assert(withWords(11).includes("11 слов"), "11 слов");
assert(withWords(22).includes("22 слова"), "22 слова");

// ---------------------------------------------------------------------------
// factsBlock — reuses the errand-brief spelling, adds nothing secret
// ---------------------------------------------------------------------------

eq(factsBlock({}), null, "no facts → no block");

const realistic: PersonFacts = {
  displayName: "Никита",
  contactName: "Никита Ерохин",
  phone: "+7 916 000-11-22",
  address: {
    recipientName: "Никита Ерохин",
    line1: "ул. Льва Толстого, 16, кв. 5",
    city: "Москва",
    postalCode: "119021",
    countryCode: "RU",
  },
  tz: "Europe/Moscow",
  nowLocal: "среда, 17 сентября 2025 г., 14:32",
  openErrands: ["кроссовки на WB, 43 размер", "стол в Probka на пятницу 19:00"],
};

const block = factsBlock(realistic);
assert(block !== null, "realistic facts produce a block");
assert(block.startsWith("Кто этот человек:"), "block is labelled");
assert(block.includes("зовут: Никита"), "display name reuses the errand spelling");
assert(block.includes("ул. Льва Толстого"), "address is included");
assert(block.includes("в работе: кроссовки на WB"), "open errands are one line");
assert(!block.includes("город: Москва"), "city is not repeated next to the address");
assert(
  factsBlock({ displayName: "Никита", city: "Москва" })?.includes("город: Москва"),
  "city stands alone when there is no address",
);

// ---------------------------------------------------------------------------
// secrets never travel
// ---------------------------------------------------------------------------

const leaky = factsBlock({
  displayName: "Никита",
  openErrands: ["оплатить подписку картой 4111 1111 1111 1111", "пароль: hunter2024"],
});
assert(leaky !== null, "leaky facts still produce a block");
assert(!leaky.includes("4111"), `card number must not survive: ${leaky}`);
assert(leaky.includes("[card]"), "card number is redacted, not silently dropped");
assert(!leaky.includes("hunter2024"), `password must not survive: ${leaky}`);

const leakyProfile = personProfile({
  facts: { displayName: "Никита", openErrands: ["карта 4111 1111 1111 1111"] },
  style: lower,
});
assert(leakyProfile !== null, "profile assembles");
assert(!leakyProfile.includes("4111"), "the assembled profile is scrubbed too");

// ---------------------------------------------------------------------------
// personProfile — budget, trim order, emptiness
// ---------------------------------------------------------------------------

eq(personProfile({}), null, "nothing in, nothing out");
eq(personProfile({ facts: {}, style: null }), null, "empty facts and no style → null");
assert(personProfile({ facts: {}, style: lower }) !== null, "style alone is a profile");
assert(personProfile({ facts: realistic, style: null }) !== null, "facts alone are a profile");

const full = personProfile({ facts: realistic, style: lower });
assert(full !== null, "realistic profile assembles");
assert(full.includes("Кто этот человек:"), "facts half present");
assert(full.includes("Как он пишет:"), "style half present");
assert(
  estimateTokens(full) <= PERSON_PROFILE_MAX_TOKENS,
  `realistic profile is ~${estimateTokens(full)} tok`,
);

// The bloat case the budget exists for: a long address plus a backlog.
const bloated: PersonFacts = {
  ...realistic,
  openErrands: Array.from(
    { length: 20 },
    (_, i) => `поручение номер ${i + 1}: разобраться с доставкой и перезвонить в пункт выдачи`,
  ),
};
const trimmed = personProfile({ facts: bloated, style: emoji });
assert(trimmed !== null, "bloated input still produces a profile");
assert(
  estimateTokens(trimmed) <= PERSON_PROFILE_MAX_TOKENS,
  `bloated profile is ~${estimateTokens(trimmed)} tok, over ${PERSON_PROFILE_MAX_TOKENS}`,
);
assert(trimmed.includes("поручение номер 1"), "the newest errands survive");
assert(!trimmed.includes("поручение номер 20"), "the backlog is dropped first");
assert(trimmed.includes("ул. Льва Толстого"), "the address outlives the backlog");
assert(trimmed.includes("Как он пишет:"), "the style line is never what gets cut");
// Nothing is cut mid-line: every line is either whole or absent.
for (const line of trimmed.split("\n")) {
  assert(!line.endsWith(","), `line cut mid-list: ${line}`);
  assert(line.trim().length > 0, "no blank lines");
}

// An address nobody could fit: the street goes, the city stays.
const absurd = personProfile({
  facts: {
    ...realistic,
    address: { ...realistic.address!, line1: `ул. ${"Длинноназванная ".repeat(120)}1` },
  },
  style: lower,
});
assert(absurd !== null, "an absurd address does not kill the profile");
assert(
  estimateTokens(absurd) <= PERSON_PROFILE_MAX_TOKENS,
  `absurd profile is ~${estimateTokens(absurd)} tok`,
);
assert(!absurd.includes("Длинноназванная"), "the unusable street is dropped whole");
assert(absurd.includes("город: Москва"), "the city survives the address");
assert(absurd.includes("зовут: Никита"), "the name is the last thing to go");

// ---------------------------------------------------------------------------
// the inject — silence is the failure mode
// ---------------------------------------------------------------------------

const inject = src("agent/instructions/profile.ts");
assert(inject.includes('"turn.started"'), "profile rides turn.started");
assert(inject.includes('role: "system"'), "profile is a system instruction");
assert(
  !inject.includes('role: "user"'),
  "profile must not append to eve session history",
);
assert(inject.includes("try {") && inject.includes("} catch"), "Convex failure is caught");
assert(
  !/catch[\s\S]{0,400}defineInstructions/.test(inject),
  "a failed profile returns null, never an error line in the prompt",
);
assert(
  !/instanceof Error/.test(inject),
  "no error text is ever formatted into the prompt",
);
assert(inject.includes("tenantId(ctx)"), "profile is scoped to this person");
assert(inject.includes("jobWakeRows"), "open errands reuse the cached job snapshot");
// Mentions in the WHY comment are fine — a call is not. A `readVaultSecret`
// on this path would put a Convex action plus a decrypt in front of every
// turn's first token, for an address chat almost never needs.
for (const banned of ["readVaultSecret", "loadErrandFacts", "listVaultItems"]) {
  assert(
    !new RegExp(`(?:import[^;]*|\\.)${banned}\\b|\\b${banned}\\(`, "u").test(inject),
    `no vault read on the per-turn path: ${banned}`,
  );
}
assert(inject.includes("Promise.all"), "the two Convex reads run in parallel");

// The dynamic inject's own literals are charged to the per-turn budget as an
// upper bound (scripts/lib/prompt-budget.ts). All of this block's Russian text
// lives in agent/lib/person-profile.ts, which is not charged — the inject must
// stay free of long prompt literals or it pays twice.
for (const m of inject.matchAll(/(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
  const body = (m[1] ?? "").slice(1, -1);
  assert(
    !(body.length >= 40 && body.includes(" ")),
    `prompt-sized literal in the inject: ${body.slice(0, 60)}`,
  );
}

console.log("person-profile-check ok");
