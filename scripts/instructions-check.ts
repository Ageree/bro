import { assert, src } from "./lib/check.ts";

/**
 * A4: guards the canonical "результат тула → что сказать" table and the
 * jargon/phrasing rules it replaced (A5 Appendix C/F, A4-worker-otp F3).
 * Byte ceiling: the rewrite is meant to stay about the same length as the
 * pre-A4 file (19,326 bytes) — this asserts it never balloons past +10%.
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

// --- length ceiling: same-or-shorter intent, hard cap at +10% over baseline ---
const BASELINE_BYTES = 19_326; // agent/instructions.md size before the A4 rewrite
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
