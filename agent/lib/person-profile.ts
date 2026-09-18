/**
 * Who Bro is talking to — the block that belongs in front of every turn.
 *
 * WHY this exists. The system prompt spends ~1200 tokens of §Voice telling the
 * model HOW to talk («пиши в его регистре», «эмодзи — только если он поставил
 * первым», «длину меряй по человеку») and zero tokens on WHO it is talking to.
 * That is backwards for the model this agent runs (deepseek-v4.1-flash with
 * reasoning off): «пиши в его регистре» is unexecutable when the register is
 * nowhere in the context — the rule names a variable the prompt never binds.
 * The SHOWN register («последние сообщения: всё с маленькой буквы, без точек,
 * в среднем 4 слова, эмодзи не ставит») is reproduced well by exactly the same
 * model, because it is data, not an instruction to derive data.
 *
 * So this module emits FACTS, in two independent halves:
 *
 *  1. `factsBlock()` — what Bro already knows about the person. It reuses
 *     `ErrandFacts` / `factLines()` from `agent/lib/known-facts.ts` rather
 *     than re-deriving the same six lines: that module already decided how a
 *     name, a phone, an address and «сейчас» are spelled, and two spellings of
 *     one fact is how the two blocks start contradicting each other.
 *  2. `styleBlock()` — how the person writes, MEASURED from their own recent
 *     messages. Never an order («пиши с маленькой буквы»), always an
 *     observation («он пишет с маленькой буквы»). The difference is not
 *     cosmetic: a weak model applies an order literally and at the wrong
 *     moment, and applies an observation the way a person would — flexibly,
 *     and only where it fits.
 *
 * Secrets never travel this way, by construction: the facts half accepts only
 * the non-secret vault kinds (`address`, `contact`) that `errand-context.ts`
 * already parses, and every assembled block goes through `scrubSecrets` as a
 * last-resort net over free text — the same discipline `errand-brief.ts` uses.
 * Passwords, PANs, CVVs and OTPs have no field to arrive in and are redacted
 * even if one is smuggled inside an errand title.
 *
 * Hard budget: this is per-turn, per-person, forever. `PERSON_PROFILE_MAX_TOKENS`
 * is enforced by `personProfile()` itself, by DROPPING whole facts in priority
 * order — never by cutting a line in half, because half a street address is
 * worse than no street address.
 */

import { scrubSecrets } from "../../convex/lib/secretScrub.ts";
import { factLines, type ErrandFacts } from "./known-facts.ts";
// Only the pure `estimateTokens` is used here — the rest of that module reads
// the repo tree and never runs at agent runtime. Sharing the estimator is the
// point: a budget measured with a different ruler than `npm run budget` is not
// a budget.
import { estimateTokens } from "../../scripts/lib/prompt-budget.ts";

/**
 * Everything non-secret Bro knows about the person, as the profile block needs
 * it. A superset of `ErrandFacts`: same fields, same meaning, same spelling —
 * plus the two the browser lane has no use for.
 */
export type PersonFacts = ErrandFacts & {
  /** Where the person is, when no full delivery address is on file. Derived
   *  from `address.city` when the address has to be dropped for budget. */
  city?: string;
  /** Open errands/jobs, one short line each, newest first. Not the goal text
   *  verbatim — these are already the one-line summaries the job store keeps. */
  openErrands?: readonly string[];
};

/**
 * The whole block, in estimated tokens (`scripts/lib/prompt-budget.ts`).
 *
 * This is a truncation cap, but it is also what the per-turn budget is
 * CHARGED for this module (`agent/instructions/profile.ts` declares it with a
 * `prompt-budget: runtime` marker), because a block assembled from Convex rows
 * has no literals to weigh. So the cap has to stay near what the block really
 * costs, or it buys headroom with a number nobody pays: a realistic full
 * profile — name, contact, phone, vault address, local time and three open
 * errands, plus the measured style line — comes to ~156, and what the live
 * inject assembles today is ~109. 250 leaves room for a long address without
 * pretending the block is twice the size it is.
 */
export const PERSON_PROFILE_MAX_TOKENS = 250;

/** Per-errand cap. An errand line is a reminder, not the errand's full text. */
const ERRAND_LINE_CHARS = 90;

/** How many open errands survive the first trim step. Three is what a person
 *  can actually be juggling at once; past that the list is a backlog, and a
 *  backlog belongs in the job tool, not in every prompt. */
const ERRANDS_KEPT_WHEN_TRIMMING = 3;

const FACTS_HEADER = "Кто этот человек:";
const STYLE_HEADER = "Как он пишет:";

function errandsLine(errands?: readonly string[]): string | null {
  if (!errands || errands.length === 0) return null;
  const items = errands
    .map((e) => e.replace(/\s+/gu, " ").trim())
    .filter((e) => e.length > 0)
    .map((e) => (e.length > ERRAND_LINE_CHARS ? `${e.slice(0, ERRAND_LINE_CHARS - 1)}…` : e));
  if (items.length === 0) return null;
  // One line, not one line each: the labels («в работе:») cost more than the
  // separators, and this block is charged on every single call.
  return `в работе: ${items.join("; ")}`;
}

/**
 * The known-facts half, or null when Bro knows nothing worth saying. Null
 * rather than an empty header: a block that announces «Кто этот человек:» and
 * then says nothing teaches the model that the section is noise.
 */
export function factsBlock(facts: PersonFacts): string | null {
  const lines = [...factLines(facts)];
  // The address already names the city; repeating it is pure tax. `city`
  // earns its line only when the address is absent (or was trimmed away).
  const city = facts.city?.trim();
  if (!facts.address && city) lines.push(`город: ${city}`);
  const errands = errandsLine(facts.openErrands);
  if (errands) lines.push(errands);
  if (lines.length === 0) return null;
  // `factLines` already scrubs its own output; this catches the fields it does
  // not own — a card number typed into an errand title, most plausibly.
  return scrubSecrets([FACTS_HEADER, ...lines.map((line) => `- ${line}`)].join("\n"));
}

// ---------------------------------------------------------------------------
// style — measured, never declared
// ---------------------------------------------------------------------------

/** One incoming message from the person, oldest first. */
export type StyleSample = { text: string };

export type WritingStyle = {
  /** Starts messages with a lowercase letter. */
  lowercase: boolean;
  /** Closes messages with a full stop. */
  endsPunctuation: boolean;
  usesEmoji: boolean;
  /** The emoji seen most recently, newest first — so Bro can see which ones
   *  are already spent instead of echoing the last one back. */
  recentEmoji: readonly string[];
  avgWords: number;
};

/**
 * Fewest WRITTEN samples that can carry a claim about a person.
 *
 * Two is not enough: one «Ок.» and one «да» is a coin flip, and the block
 * states its findings as fact, so a wrong reading is worse than silence. Three
 * is the smallest count where a 2-of-3 majority means something.
 */
export const MIN_STYLE_SAMPLES = 3;

/** The share of samples that must agree before a register is called a habit. */
const REGISTER_MAJORITY = 2 / 3;

const RECENT_EMOJI_MAX = 4;

/** How many trailing messages are ever measured. Style is a recent habit, not
 *  a biography, and an old batch would keep outvoting a change. */
export const STYLE_SAMPLE_WINDOW = 8;

/** ZWJ sequences and skin-tone modifiers count as ONE emoji, so «👨‍👩‍👧» is not
 *  reported back as three. Same `\p{Extended_Pictographic}` base class
 *  `agent/lib/fast-ack.ts` folds on. */
const EMOJI_RUN =
  /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*)*/gu;

const VOICE_PREFIX = /^\[voice\]\s*/iu;

type Classified = {
  /** `written` — typed by the person, usable for register and punctuation.
   *  `spoken` — a `[voice]` transcript: their words, but not their typing. */
  kind: "written" | "spoken";
  text: string;
};

/**
 * Splits a raw inbound line into "the person's own writing", "the person's own
 * speech" and "not the person at all".
 *
 * Anything opening with `[` is a channel/system line — `[button] …` is a tap,
 * `[event:mail]` is an inbound letter, `[background wakeup] …` is Bro's own
 * scheduler talking to itself. Measuring a person's register off Bro's wakeup
 * prompts would report Bro's register back to Bro.
 *
 * `[voice] …` is the one exception, and only a half-exception: the transcript
 * IS the person's words, but the CAPITALISATION AND PUNCTUATION IN IT ARE THE
 * TRANSCRIBER'S. A person who never types a capital letter would be measured
 * as a diligent punctuator purely because Whisper writes «Купи молока.» So a
 * voice line counts toward message length and nothing else.
 */
function classify(raw: string): Classified | null {
  const t = raw.trim();
  if (!t) return null;
  const voice = VOICE_PREFIX.exec(t);
  if (voice) {
    const body = t.slice(voice[0].length).trim();
    return body ? { kind: "spoken", text: body } : null;
  }
  if (t.startsWith("[")) return null;
  return { kind: "written", text: t };
}

function firstCasedLetter(s: string): string | null {
  for (const ch of s) {
    if (!/\p{L}/u.test(ch)) continue;
    // Caseless scripts and digits say nothing about register.
    if (ch.toLowerCase() !== ch.toUpperCase()) return ch;
  }
  return null;
}

function wordCount(s: string): number {
  return s.split(/\s+/u).filter((w) => w.length > 0).length;
}

/** Trailing emoji are not punctuation — «готово 🙂» ends unpunctuated. One flat
 *  character class rather than a repeat of `EMOJI_RUN`: nesting that pattern
 *  inside another `+` is a backtracking trap, and here the exact sequence
 *  boundaries do not matter — everything decorative at the end simply goes. */
const TRAILING_DECOR = /[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍\s]+$/u;

function stripTrailingEmoji(s: string): string {
  return s.replace(TRAILING_DECOR, "");
}

function emojiIn(s: string): string[] {
  return s.match(EMOJI_RUN) ?? [];
}

/**
 * The person's writing habits, or null when the sample cannot support a claim.
 *
 * `samples` are the person's own inbound messages in chronological order
 * (oldest first); only the last `STYLE_SAMPLE_WINDOW` are measured.
 *
 * Returns null when there are fewer than `MIN_STYLE_SAMPLES` written samples,
 * or when the register is genuinely mixed (no 2/3 majority either way). The
 * register is the load-bearing fact of this block — it is the one §Voice rule
 * the model cannot execute unaided — so a block that cannot state it has
 * nothing left worth a line.
 */
export function measureStyle(samples: readonly StyleSample[]): WritingStyle | null {
  const classified = samples
    .slice(-STYLE_SAMPLE_WINDOW)
    .map((s) => classify(typeof s?.text === "string" ? s.text : ""))
    .filter((c): c is Classified => c !== null);
  const written = classified.filter((c) => c.kind === "written").map((c) => c.text);
  if (written.length < MIN_STYLE_SAMPLES) return null;

  let lower = 0;
  let upper = 0;
  for (const text of written) {
    const ch = firstCasedLetter(text);
    if (!ch) continue;
    if (ch === ch.toLowerCase()) lower += 1;
    else upper += 1;
  }
  const cased = lower + upper;
  if (cased < MIN_STYLE_SAMPLES) return null;
  const lowercase = lower >= cased * REGISTER_MAJORITY;
  const uppercase = upper >= cased * REGISTER_MAJORITY;
  if (!lowercase && !uppercase) return null;

  // A question mark says the sentence was a question, not that the person
  // punctuates; «сколько стоит?» is typed by people who never write a full
  // stop. Those samples are left out of the vote entirely rather than counted
  // as either habit.
  const punctuable = written
    .map(stripTrailingEmoji)
    .filter((t) => t.length > 0 && !t.endsWith("?"));
  const punctuated = punctuable.filter((t) => /[.!…]$/u.test(t)).length;
  const endsPunctuation = punctuable.length > 0 && punctuated * 2 > punctuable.length;

  // Emoji are read from written samples only: a transcript carries whatever
  // the transcriber felt like emitting, which is not the person's habit.
  const recent: string[] = [];
  for (let i = written.length - 1; i >= 0 && recent.length < RECENT_EMOJI_MAX; i -= 1) {
    for (const e of emojiIn(written[i] ?? "")) {
      if (!recent.includes(e)) recent.push(e);
      if (recent.length >= RECENT_EMOJI_MAX) break;
    }
  }

  // Length counts speech too: «купи молока» is the same length whether it was
  // typed or dictated, and voice lines are often the only samples a new person
  // has produced.
  const lengths = classified.map((c) => wordCount(c.text));
  const avgWords =
    Math.round((lengths.reduce((n, w) => n + w, 0) / lengths.length) * 10) / 10;

  return {
    lowercase,
    endsPunctuation,
    usesEmoji: recent.length > 0,
    recentEmoji: recent,
    avgWords,
  };
}

function wordsNoun(n: number): string {
  const i = Math.abs(Math.round(n));
  const mod10 = i % 10;
  const mod100 = i % 100;
  if (mod10 === 1 && mod100 !== 11) return "слово";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "слова";
  return "слов";
}

/**
 * One or two lines of observation. Deliberately in the third person and in the
 * present tense — «он пишет», never «пиши». An imperative in this block would
 * be obeyed as a rule (every bubble lowercased, including the one quoting an
 * order number); a description is applied the way a person applies it.
 */
export function styleBlock(style: WritingStyle): string {
  const words = Math.round(style.avgWords);
  const parts = [
    style.lowercase ? "с маленькой буквы" : "с заглавной буквы",
    style.endsPunctuation ? "с точками в конце" : "без точек в конце",
    `в среднем ${words} ${wordsNoun(words)} в сообщении`,
  ];
  const emoji = style.usesEmoji
    ? style.recentEmoji.length > 0
      ? `эмодзи ставит, последние были: ${style.recentEmoji.join(" ")}`
      : "эмодзи ставит"
    : "эмодзи не ставит";
  return `${STYLE_HEADER} ${parts.join(", ")}; ${emoji}.`;
}

// ---------------------------------------------------------------------------
// assembly + budget
// ---------------------------------------------------------------------------

function omit(facts: PersonFacts, keys: readonly (keyof PersonFacts)[]): PersonFacts {
  const out: PersonFacts = { ...facts };
  for (const key of keys) delete out[key];
  return out;
}

/**
 * The same facts at decreasing width, widest first. Priority is what the
 * person loses LAST: their name and the current local time are why the block
 * exists at all, the open errands are the most repeatable thing in it (the job
 * store injects them separately anyway), and a delivery address is a checkout
 * detail rather than a fact about who they are.
 */
function factVariants(facts?: PersonFacts): (PersonFacts | undefined)[] {
  if (!facts) return [undefined];
  const fewerErrands: PersonFacts = facts.openErrands?.length
    ? { ...facts, openErrands: facts.openErrands.slice(0, ERRANDS_KEPT_WHEN_TRIMMING) }
    : facts;
  const noErrands = omit(fewerErrands, ["openErrands"]);
  // Dropping the address keeps the city: where the person is stays useful for
  // shops, delivery windows and «рядом с домом» long after the street is gone.
  const city = noErrands.city ?? noErrands.address?.city;
  const noAddress: PersonFacts = {
    ...omit(noErrands, ["address"]),
    ...(city ? { city } : {}),
  };
  const noContact = omit(noAddress, ["phone", "email", "contactName"]);
  return [facts, fewerErrands, noErrands, noAddress, noContact];
}

/**
 * The whole block, or null when there is nothing to say. Guaranteed to fit
 * `PERSON_PROFILE_MAX_TOKENS`: variants are tried widest-first and the first
 * one that fits wins, so what gets dropped is always a complete fact.
 */
export function personProfile(input: {
  facts?: PersonFacts;
  style?: WritingStyle | null;
}): string | null {
  const style = input.style ? styleBlock(input.style) : null;
  for (const variant of factVariants(input.facts)) {
    const facts = variant ? factsBlock(variant) : null;
    const text = [facts, style].filter((p): p is string => Boolean(p)).join("\n");
    if (!text) break;
    if (estimateTokens(text) <= PERSON_PROFILE_MAX_TOKENS) return text;
  }
  // Every fact variant was still too wide (an absurd address, say). The style
  // line is one sentence and always fits, and it is the half the model cannot
  // reconstruct on its own.
  if (style && estimateTokens(style) <= PERSON_PROFILE_MAX_TOKENS) return style;
  return null;
}

// ---------------------------------------------------------------------------
// reading samples out of a turn's message history
// ---------------------------------------------------------------------------

type HistoryMessage = { role?: unknown; content?: unknown };

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  const text = (part as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

/**
 * The person's own lines out of an eve message history, oldest first.
 *
 * Defensive on purpose, exactly like `recallQuery` in
 * `agent/lib/archive-policy.ts`: the history is a model-facing structure, and
 * a shape change there must cost this block its style line, never the turn.
 * Assistant and tool messages are skipped; `classify()` above drops the
 * `user`-role lines that are not actually the person.
 */
export function styleSamplesFromMessages(
  messages: readonly unknown[] | undefined,
): StyleSample[] {
  if (!Array.isArray(messages)) return [];
  const out: StyleSample[] = [];
  for (const raw of messages) {
    const m = raw as HistoryMessage | null;
    if (m?.role !== "user") continue;
    const text = Array.isArray(m.content)
      ? m.content.map(partText).filter(Boolean).join("\n")
      : partText(m.content);
    const trimmed = text.trim();
    if (trimmed) out.push({ text: trimmed });
  }
  return out.slice(-STYLE_SAMPLE_WINDOW);
}
