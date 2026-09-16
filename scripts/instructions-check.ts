import { assert, src } from "./lib/check.ts";

/**
 * Guards the canonical "результат тула → что сказать" table, the
 * jargon/phrasing rules it replaced (A5 Appendix C/F, A4-worker-otp F3), and
 * the voice rules from the "человечный Bro" rewrite, re-sharpened against the
 * register the owner pointed at (Poke / Instinct): match the human's length
 * and capitalisation, never open an emoji, wit on a short leash, no flattery,
 * bad news first, silence is a real turn.
 * Byte ceiling: the Poke/Instinct pass grew ## Voice by ~1.8k, so the baseline
 * is re-taken here — this asserts the file never grows past +10% of it.
 */

const instructions = src("agent/instructions.md");

// --- canonical table header (F10/F14: one table, not scattered prose) ---
assert(
  instructions.includes("## Canonical tool-result → reply table"),
  "canonical tool-result table header present",
);
assert(
  instructions.includes("| результат тула | что сказать |"),
  "canonical table has its column header row",
);

// --- required phrasing (F9/F10/F13/F14 fixes must actually be present) ---
for (const needle of [
  "проверяю", // confirm ack (подтвердил/готово/вошёл)
  "ввожу код", // code-inject first bubble
  "подожду", // wait-inject first bubble
  "сначала закончу", // busy queueing line
  "reset:true", // отмени/забудь/начни заново
  "otp_lookup", // mailbox-first OTP lookup
  "errand", // profile_setup resumes the original ask
]) {
  assert(instructions.includes(needle), `instructions.md must contain "${needle}"`);
}

// --- forbidden jargon/anglicisms leaking into human-facing text (A5 F11, A4-worker-otp F3) ---
for (const needle of [
  "джоб",
  "3-D Secure the cloud job",
  "Cloud-сесси",
  "browser-job",
]) {
  assert(
    !instructions.includes(needle),
    `instructions.md must not contain "${needle}"`,
  );
}

// "Cloud" never stands alone as a brand-ish word the model could echo
// (Appendix F) — "браузер"/"живая вкладка"/"открытая страница" replace it.
assert(!instructions.includes("Cloud"), "instructions.md drops the bare word Cloud");

// --- voice: Bro texts like a person, not a status machine ---
// The robotic phrasings must be named in the file so the model is steered off
// them; each one is quoted inside the "так не пиши" block of ## Voice.
for (const robotic of [
  "Задача принята",
  "Статус:",
  "Выполняю запрос",
  "Готов помочь!",
  "Прошу прощения за доставленные неудобства",
]) {
  assert(
    instructions.includes(robotic),
    `instructions.md must ban the robotic phrasing "${robotic}"`,
  );
}
assert(
  /не начинай сообщение с «Бро\.»/.test(instructions),
  "instructions.md keeps the «Бро.» opener ban",
);
assert(
  instructions.includes("не отчитывайся списком с буллетами"),
  "instructions.md bans bullet-point reports",
);
assert(
  instructions.includes("Не пересказывай просьбу обратно человеку"),
  "instructions.md bans restating the user's request back at them",
);

// --- Poke/Instinct register: the traits the owner's reference points show ---
// Each of these is a checkable rule in ## Voice, not a vibe.
for (const [needle, what] of [
  // Poke: "match your response length approximately to the user's".
  ["Длину меряй по человеку", "reply length tracks the human's"],
  // Poke: "Adapt to the texting style of the user. Use lowercase if the user
  // does. Never use obscure acronyms or slang if the user has not first."
  ["Пиши в его регистре", "capitalisation/slang follow the human"],
  // Poke: "Never text with emojis if the user has not texted them first" and
  // never reuse the emoji from their last few messages.
  ["Эмодзи — только если он поставил первым", "Bro never opens an emoji"],
  ["не те же, что у него в последних сообщениях", "Bro does not echo their emoji"],
  // Poke: subtle wit, "Never make multiple jokes in a row", never unoriginal,
  // "Never ask if the user wants to hear a joke", no "lol" as filler.
  ["Две подряд не ставь", "wit stays on a short leash"],
  // Poke: "never be sycophantic".
  ["лести никогда", "no sycophancy"],
  // Poke: when the user is just chatting, do not offer help — «привет» gets
  // «what's up», not «Hi! How can I help you today?».
  ["не предлагай помощь", "small talk is answered, not upsold"],
  // Instinct: leads with the straight story when something went wrong.
  ["Плохую новость — первой строкой", "bad news goes first and plainly"],
  // Poke: "you can react or output an empty string to say nothing".
  ["промолчи или поставь реакцию", "silence/a tapback is a real turn"],
] as const) {
  assert(instructions.includes(needle), `instructions.md voice rule: ${what}`);
}

// The first bubble of an errand turn is a freshly worded "я взялся" line, not
// a hardcoded «ищу» — varied wording is the whole point of the rewrite.
assert(
  /2–6 слов/.test(instructions),
  "instructions.md sets the 2–6 word window for the opening line",
);
assert(
  instructions.includes("с маленькой буквы, без точки в конце"),
  "instructions.md sets the lowercase, no-final-period shape",
);
// Poke: "Never output preamble or postamble" / "never repeat what the user
// says directly back at them when acknowledging".
assert(
  instructions.includes("Без вступления, сразу с дела"),
  "instructions.md keeps the opening line preamble-free",
);
assert(
  instructions.includes("особенно с «ищу»"),
  "instructions.md forbids always opening with «ищу»",
);
assert(
  instructions.includes("сказанное в тот раз в этот раз не повторяй"),
  "instructions.md forbids reusing the previous turn's wording",
);

// The owner's steer: the model must WRITE the line, not pick one off a list.
// A menu of ready-made beats is rotation, not speech — however long the menu
// is — so the file must ask for fresh wording and must not ship a roster to
// choose from.
assert(
  instructions.includes("Формулируй её сам, каждый раз с нуля"),
  "instructions.md asks the model to compose the line itself",
);
assert(
  instructions.includes("Готовых заготовок не держи"),
  "instructions.md bans keeping stock phrases",
);
{
  const section = instructions.slice(
    instructions.indexOf("### Строка «взялся»"),
    instructions.indexOf("## Groups"),
  );
  assert(section.length > 0, "the «взялся» section is still in the file");
  const quoted = [...section.matchAll(/«([^»]+)»/g)]
    .map((m) => m[1]!)
    // Words the rules talk ABOUT rather than beats offered for reuse.
    .filter((q) => !["ищу", "взялся", "ок", "спасибо", "понял"].includes(q));
  assert(
    quoted.length <= 3,
    `the «взялся» section offers ${quoted.length} ready-made beats — at most 3 may stand as illustration, the rest is a menu to copy`,
  );
}

// --- length ceiling: same-or-shorter intent, hard cap at +10% over baseline ---
const BASELINE_BYTES = 21_980; // agent/instructions.md size after the Poke/Instinct voice pass
const CEILING_BYTES = Math.ceil(BASELINE_BYTES * 1.1);
const actualBytes = Buffer.byteLength(instructions, "utf8");
assert(
  actualBytes <= CEILING_BYTES,
  `instructions.md is ${actualBytes} bytes, over the ${CEILING_BYTES}-byte ceiling (+10% of baseline)`,
);

const pkg = src("package.json");
assert(pkg.includes("\"instructions:check\""), "package.json instructions:check");
assert(pkg.includes("instructions-check.ts"), "instructions:check runs this script");

console.log("instructions-check ok");
