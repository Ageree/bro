import {
  turnVoice,
  voiceInstruction,
  type VoiceInput,
  type VoiceVerdict,
} from "../agent/lib/turn-voice.ts";
import { assert, eq, src } from "./lib/check.ts";

const BASE: VoiceInput = {
  origin: "human",
  shortAck: false,
  waitingForHuman: false,
  jobCheck: false,
  dueNudges: 0,
  browserPollForceSpeak: false,
};

function voice(patch: Partial<VoiceInput>): VoiceVerdict {
  return turnVoice({ ...BASE, ...patch });
}

// --- 1. the truth table, one row per branch of the priority order ---

// (1) must_speak beats everything below it: the server already resolved a
// concrete outcome, so silence here is the 2026-09-05 taxi regression.
eq(voice({ browserPollForceSpeak: true, origin: "wakeup" }), "must_speak", "resolved browser errand speaks");
eq(voice({ dueNudges: 1, jobCheck: true, origin: "wakeup" }), "must_speak", "a due nudge speaks");
eq(
  voice({ dueNudges: 2, jobCheck: true, origin: "wakeup", browserPollForceSpeak: false }),
  "must_speak",
  "several due nudges still one must_speak verdict",
);
eq(
  voice({ browserPollForceSpeak: true, shortAck: true }),
  "must_speak",
  "force-speak outranks a short ack",
);
eq(
  voice({ dueNudges: 1, jobCheck: true, origin: "wakeup", waitingForHuman: true }),
  "must_speak",
  "a due nudge outranks the quiet job_check rule",
);

// (2) ack_only — «ок» with nothing waiting on the human.
eq(voice({ shortAck: true }), "ack_only", "idle short ack is ack-only");
// …but an ack while a job waits on HIM is his answer, not small talk: acking
// it back would stall the job, so the turn proceeds instead.
eq(
  voice({ shortAck: true, waitingForHuman: true }),
  "ack_confirms",
  "short ack that answers a waiting job proceeds",
);
{
  const text = voiceInstruction("ack_confirms") ?? "";
  assert(
    /confirm/i.test(text) && /next step/i.test(text),
    "ack_confirms tells the model to take the next step rather than re-ask",
  );
  assert(
    !/\[SILENT\]/.test(text),
    "ack_confirms never offers silence — a job is waiting on this answer",
  );
}

// (3) may_silent — background work that owes nobody a line.
eq(voice({ jobCheck: true, origin: "wakeup" }), "may_silent", "quiet job_check may stay silent");
eq(voice({ origin: "wakeup" }), "may_silent", "a plain wakeup may stay silent");
eq(
  voice({ origin: "wakeup", waitingForHuman: true }),
  "may_silent",
  "an open human wait that is NOT yet due does not force speech",
);

// (4) free — ordinary human turn.
eq(voice({}), "free", "an ordinary human turn has no voice constraint");
eq(voice({ origin: undefined }), "free", "unstamped origin falls through to free");
eq(voice({ waitingForHuman: true }), "free", "an open wait alone constrains nothing");

// --- 2. must_speak carries the actual nudge lines ---

const nudges = [
  "Нужен твой ответ, чтобы продолжить: слот. вт 15:00?",
  "Всё ещё жду письмо от клиники/почты: запись.",
];
const mustSpeak = voiceInstruction("must_speak", { nudges });
assert(mustSpeak !== null, "must_speak produces an instruction");
for (const line of nudges) {
  assert(mustSpeak.includes(line), `must_speak repeats the nudge line: ${line}`);
}
assert(mustSpeak.includes("[SILENT]"), "must_speak names the thing it forbids");
assert(
  voiceInstruction("must_speak", {})?.includes("[SILENT]"),
  "must_speak without nudges (browser_poll) still forbids [SILENT]",
);
assert(
  !voiceInstruction("must_speak", { nudges: ["", "   "] })?.includes("\n"),
  "blank nudge lines are dropped, not appended as empty lines",
);

// --- 3. the regression test on the conflict itself ---
//
// «Ignore any later line that allows [SILENT]» used to live in
// jobNudgeInstruction: an in-code admission that the assembled prompt
// contradicted itself. One verdict per turn means there is no later line to
// ignore, and no verdict may ever reintroduce that phrasing.
const VERDICTS: VoiceVerdict[] = [
  "must_speak",
  "ack_only",
  "ack_confirms",
  "may_silent",
  "free",
];
for (const verdict of VERDICTS) {
  const text = voiceInstruction(verdict, { nudges }) ?? "";
  assert(
    !/ignore any later/i.test(text),
    `${verdict} must not tell the model to ignore another instruction`,
  );
}
for (const rel of ["agent/lib/turn-voice.ts", "agent/instructions/jobs.ts"]) {
  const body = src(rel);
  const strings = body.match(/"[^"]*"|`[^`]*`/g) ?? [];
  assert(
    !strings.some((s) => /ignore any later/i.test(s)),
    `${rel} ships no "ignore any later" string`,
  );
}

// --- 4. free is silence from the injector, not another paragraph ---
eq(voiceInstruction("free", { nudges }), null, "free injects nothing");
eq(voiceInstruction("free", {}), null, "free injects nothing without nudges");

// --- 5. word budget: a weak model reads the whole system block every turn ---
const WORD_LIMIT = 60;
function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
for (const verdict of VERDICTS) {
  const text = voiceInstruction(verdict, { nudges: nudges.slice(0, 1) });
  if (text === null) continue;
  assert(
    words(text) <= WORD_LIMIT,
    `${verdict} instruction is ${words(text)} words, over the ${WORD_LIMIT}-word budget`,
  );
}

// --- 6. the old six-way arbitration is actually gone from the wiring ---
const jobsSrc = src("agent/instructions/jobs.ts");
assert(jobsSrc.includes("turnVoice("), "turn.started decides the voice once");
assert(jobsSrc.includes("voiceInstruction("), "turn.started injects one voice block");
assert(
  !jobsSrc.includes("shortAckInstruction") &&
    !jobsSrc.includes("jobNudgeInstruction") &&
    !jobsSrc.includes("JOB_CHECK_QUIET"),
  "the competing voice instructions no longer reach the prompt",
);
assert(jobsSrc.includes("markNudged"), "due nudges are still persisted");
const jobWakeSrc = src("agent/lib/job-wake.ts");
assert(
  !jobWakeSrc.includes("jobNudgeInstruction") && !jobWakeSrc.includes("JOB_CHECK_QUIET"),
  "the retired nudge/quiet copy is deleted, not left dangling",
);
assert(
  !src("agent/lib/short-ack.ts").includes("shortAckInstruction"),
  "the retired short-ack copy is deleted, not left dangling",
);

console.log("turn-voice-check ok");
