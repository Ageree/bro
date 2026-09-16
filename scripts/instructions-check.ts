import { assert, src } from "./lib/check.ts";

/**
 * Guards the canonical "результат тула → что сказать" table, the
 * jargon/phrasing rules it replaced (A5 Appendix C/F, A4-worker-otp F3), and
 * the voice rules from the "человечный Bro" rewrite.
 * Byte ceiling: the voice rewrite cut the file from 21,182 bytes to ~19.6k
 * while keeping every behavioural rule — this asserts it never grows back
 * past +10% of that.
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

// The first bubble of an errand turn is a freshly worded "я взялся" line, not
// a hardcoded «ищу» — varied wording is the whole point of the rewrite.
assert(
  /2–6 слов/.test(instructions),
  "instructions.md sets the 2–6 word window for the opening line",
);
assert(
  instructions.includes("с маленькой буквы, без точки в конце, придумана заново"),
  "instructions.md requires a freshly worded lowercase opening line",
);
assert(
  instructions.includes("особенно с «ищу»"),
  "instructions.md forbids always opening with «ищу»",
);
assert(
  instructions.includes("не повторяй формулировку прошлого хода"),
  "instructions.md forbids reusing the previous turn's wording",
);
// The palette has to be a palette: several differently-shaped openers.
const palette = ["взялся", "принял", "беру на себя", "приступил", "сделаю"];
for (const opener of palette) {
  assert(
    instructions.includes(opener),
    `instructions.md opening-line palette includes "${opener}"`,
  );
}

// --- length ceiling: same-or-shorter intent, hard cap at +10% over baseline ---
const BASELINE_BYTES = 19_560; // agent/instructions.md size after the voice rewrite
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
