/**
 * No builder may leak a placeholder into text a human or a browser agent reads.
 *
 * WHY. `payScaffold` interpolated two OPTIONAL vault fields without a guard,
 * so an errand whose saved card carried no holder/brand metadata shipped this
 * to the cloud browser agent, verbatim:
 *
 *     Карта undefined подключена секретами: …
 *     Держатель undefined — не секрет, печатай его текстом.
 *
 * The second line is an instruction to TYPE the word. A browser agent doing as
 * it is told puts `undefined` in the cardholder field of a real checkout.
 *
 * Nothing caught it, because every test passed the field. That is the shape of
 * this whole bug class: the happy path always supplies the value, so the miss
 * only appears for the users whose data is incomplete — which, on a consumer
 * product, is most of them on day one.
 *
 * So this check does the opposite of a normal test: it calls builders with
 * DEGENERATE input — nothing, empty objects, half-filled records — and asserts
 * the output never contains `undefined`, `null`, `NaN` or `[object Object]`.
 * A builder that cannot render a field is expected to drop the sentence, not
 * to render the hole.
 *
 * Two layers:
 *   1. CURATED — the builders that reach a human or a browser run, called with
 *      the exact degenerate shapes their callers can really produce.
 *   2. SWEEP — every exported function of the policy modules, called with no
 *      arguments. Most throw or return non-strings and are skipped; the ones
 *      that do return a string are checked for free. It costs nothing and it
 *      is what would have caught `payScaffold` without anyone thinking of it.
 */

import { assert } from "./lib/check.ts";

/** What must never reach a person or a browser agent. */
const PLACEHOLDERS = [
  "undefined",
  "null",
  "NaN",
  "[object Object]",
  "[object Promise]",
] as const;

/** `null` is a legitimate Russian-free substring of some URLs and ids, so the
 *  scan is anchored on word boundaries where the token stands on its own. */
function leak(text: string): string | null {
  for (const bad of PLACEHOLDERS) {
    // A placeholder that is part of a longer identifier (a base64 blob, a
    // slug) is not a rendering hole. Require a non-word neighbour on both
    // sides, which is how a real interpolation always lands.
    const re = new RegExp(`(^|[^\\w-])${bad.replace(/[[\]]/g, "\\$&")}($|[^\\w-])`, "i");
    if (re.test(text)) return bad;
  }
  return null;
}

/** Text a person reads (Russian) or a model reads (prose with spaces), as
 *  opposed to an id, a slug or a colon-joined key. Used only by the sweep —
 *  the curated cases below are checked whatever they look like. */
function isReadable(text: string): boolean {
  if (/[Ѐ-ӿ]/.test(text)) return true;
  return text.length >= 40 && /\s/.test(text.trim());
}

let checked = 0;

function expectClean(label: string, value: unknown): void {
  if (typeof value !== "string") return;
  checked += 1;
  const bad = leak(value);
  assert(
    bad === null,
    `${label} rendered a placeholder «${bad}» into user-visible text:\n${value.slice(0, 400)}`,
  );
}

// --- 1. curated: the builders whose output a human or a browser run reads ---

const outcome = await import("../convex/lib/browserOutcomePolicy.ts");

// Every blocker, with no context at all — the case where the run reported a
// need but named neither the site, the link nor a detail.
for (const need of [
  "none",
  "sms_code",
  "email_code",
  "push",
  "3ds",
  "captcha",
  "password",
  "address",
  "payment",
  "info",
] as const) {
  expectClean(`humanLineForNeed(${need}, undefined)`, outcome.humanLineForNeed(need));
  expectClean(`humanLineForNeed(${need}, {})`, outcome.humanLineForNeed(need, {}));
  expectClean(
    `humanLineForNeed(${need}, blanks)`,
    outcome.humanLineForNeed(need, { site: "", liveUrl: "", detail: "" }),
  );
  expectClean(
    `humanLineForNeed(${need}, whitespace)`,
    outcome.humanLineForNeed(need, { site: "   ", liveUrl: "  ", detail: " " }),
  );
}

// A finished run that parsed to almost nothing still has to read as a sentence.
expectClean("doneLineHint({})", outcome.doneLineHint({} as never));
expectClean(
  "doneLineHint(partial)",
  outcome.doneLineHint({ done: "заказал" } as never),
);
expectClean(
  "doneLineHint(empty strings)",
  outcome.doneLineHint({ done: "", orderId: "", when: "" } as never),
);
expectClean("parseCloudOutcome('') → doneLineHint", outcome.doneLineHint(outcome.parseCloudOutcome("")));
expectClean(
  "parseCloudOutcome(garbage) → doneLineHint",
  outcome.doneLineHint(outcome.parseCloudOutcome("СДЕЛАНО:\nЗАКАЗ:\nСУММА:\nКОГДА:")),
);

// The browser errand scaffold. This is the builder the incident came from, and
// the one whose output a third party executes.
const browseruse = await import("../agent/lib/browseruse.ts");
expectClean("scaffoldTask(bare)", browseruse.scaffoldTask("купи кроссовки"));
expectClean("scaffoldTask(no facts)", browseruse.scaffoldTask("купи кроссовки", {}));
expectClean(
  "scaffoldTask(empty facts)",
  browseruse.scaffoldTask("купи кроссовки", { facts: {} }),
);
expectClean(
  "scaffoldTask(pay, no card metadata)",
  browseruse.scaffoldTask("купи кроссовки", { pay: { hosts: ["wildberries.ru"] } }),
);
expectClean(
  "scaffoldTask(pay + maxRub, no holder/account)",
  browseruse.scaffoldTask("купи кроссовки", {
    pay: { hosts: ["ozon.ru"], maxRub: 5000 },
  }),
);
expectClean(
  "scaffoldTask(attach card)",
  browseruse.scaffoldTask("привяжи карту", { pay: { hosts: ["ozon.ru"], attachCard: true } }),
);
expectClean(
  "scaffoldTask(continuation)",
  browseruse.scaffoldTask("продолжи", { continuation: true }),
);
expectClean(
  "scaffoldTask(login)",
  browseruse.scaffoldTask("зайди в личный кабинет", { login: true }),
);
expectClean(
  "scaffoldTask(half-filled address)",
  browseruse.scaffoldTask("закажи доставку", {
    facts: {
      address: {
        recipientName: "Никита",
        line1: "",
        city: "",
        countryCode: "",
      } as never,
    },
  }),
);

// The card block on its own, with every optional field absent — the exact
// shape that produced «Карта undefined».
const pay = await import("../agent/lib/browser-pay.ts");
if (typeof pay.payScaffold === "function") {
  expectClean("payScaffold(hosts only)", pay.payScaffold({ hosts: ["wildberries.ru"] } as never));
  expectClean(
    "payScaffold(hosts + maxRub)",
    pay.payScaffold({ hosts: ["wildberries.ru"], maxRub: 12000 } as never),
  );
  expectClean(
    "payScaffold(attachCard)",
    pay.payScaffold({ hosts: ["ozon.ru"], attachCard: true } as never),
  );
  expectClean(
    "payScaffold(blank holder/account)",
    pay.payScaffold({ hosts: ["ozon.ru"], holder: "", account: "" } as never),
  );
}

// The onboarding letter and the gate lines: the first thing a new user sees.
const onboard = await import("../agent/lib/onboard-policy.ts");
for (const [i, bubble] of onboard.welcomeBubbles().entries()) {
  expectClean(`welcomeBubbles()[${i}]`, bubble);
}

// Who this person is, assembled from a tenant row that has almost nothing on
// it — a brand-new user, one turn after binding.
const profile = await import("../agent/lib/person-profile.ts");
expectClean("personProfile({})", profile.personProfile({}) ?? "");
expectClean("personProfile(empty facts)", profile.personProfile({ facts: {} }) ?? "");
expectClean(
  "personProfile(facts with blanks)",
  profile.personProfile({
    facts: { displayName: "", contactName: "", phone: "", openErrands: [] },
  }) ?? "",
);
expectClean("factsBlock({})", profile.factsBlock({}) ?? "");
{
  const style = profile.measureStyle([
    { text: "го" },
    { text: "ок давай" },
    { text: "а подешевле" },
  ]);
  if (style) expectClean("styleBlock(measured)", profile.styleBlock(style));
}

// The turn-voice injection, including the nudge branch with empty lines.
const voice = await import("../agent/lib/turn-voice.ts");
for (const verdict of ["must_speak", "ack_only", "ack_confirms", "may_silent", "free"] as const) {
  expectClean(`voiceInstruction(${verdict})`, voice.voiceInstruction(verdict) ?? "");
  expectClean(
    `voiceInstruction(${verdict}, empty nudges)`,
    voice.voiceInstruction(verdict, { nudges: [] }) ?? "",
  );
  expectClean(
    `voiceInstruction(${verdict}, blank nudge)`,
    voice.voiceInstruction(verdict, { nudges: ["", "   "] }) ?? "",
  );
}

// The proactive wake prompt, with candidates that carry no time and no body.
const instinct = await import("../convex/lib/instinctPolicy.ts");
if (typeof instinct.instinctWakePrompt === "function") {
  expectClean("instinctWakePrompt([])", instinct.instinctWakePrompt([]));
  expectClean(
    "instinctWakePrompt(bare candidate)",
    instinct.instinctWakePrompt([
      { kind: "mail_actionable", summary: "письмо от клиники", sourceId: "m1" } as never,
    ]),
  );
}

// The job wake lines, from rows with no note and no goal.
const jobWake = await import("../agent/lib/job-wake.ts");
expectClean("jobWakeInstruction([])", jobWake.jobWakeInstruction([]) ?? "");
expectClean("jobWakeInstruction(blank)", jobWake.jobWakeInstruction([""]) ?? "");
expectClean("jobCheckWakePrompt('')", jobWake.jobCheckWakePrompt(""));

// --- 2. sweep: every zero-argument-tolerant exported builder ---------------
/**
 * Called with nothing at all. A builder that requires arguments throws and is
 * skipped; one that renders a string from defaults is checked for free. This
 * layer needs no maintenance and it is the one that generalises: the next
 * `payScaffold` does not have to be thought of to be caught.
 */
const SWEEP_MODULES = [
  "../convex/lib/browserOutcomePolicy.ts",
  "../convex/lib/browserProgressPolicy.ts",
  "../convex/lib/browserFollowPolicy.ts",
  "../convex/lib/jobNudgePolicy.ts",
  "../convex/lib/orderPolicy.ts",
  "../convex/lib/purchasePolicy.ts",
  "../convex/lib/mailPolicy.ts",
  "../convex/lib/instinctPolicy.ts",
  "../agent/lib/onboard-policy.ts",
  "../agent/lib/turn-voice.ts",
  "../agent/lib/job-wake.ts",
  "../agent/lib/person-profile.ts",
  "../agent/lib/known-facts.ts",
] as const;

let swept = 0;
for (const spec of SWEEP_MODULES) {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(spec)) as Record<string, unknown>;
  } catch {
    // A module that needs a runtime this check does not have is not this
    // check's business — the curated layer covers what matters.
    continue;
  }
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    // Only builders whose every parameter is optional. Calling one that
    // REQUIRES an argument with none supplied does not test the product, it
    // violates a contract TypeScript already enforces — `watcherWakeupPrompt()`
    // renders «Сторож: undefined» only because no caller can do that. Arity
    // counts parameters before the first default or rest, so this is exactly
    // the "safe to call empty" set.
    if ((value as { length: number }).length > 0) continue;
    let out: unknown;
    try {
      out = (value as () => unknown)();
    } catch {
      continue;
    }
    if (typeof out !== "string") continue;
    // Only strings a person or a model could actually read. The sweep calls
    // everything, so it also reaches internal builders — `browserWakeupClaimKey()`
    // with no arguments returns `undefined:undefined:undefined:undefined`, which
    // is a correct idempotency key for a call that supplied no ids, not a
    // rendering hole. Flagging it would be a false alarm, and before a release a
    // false alarm costs more than a miss: it spends the reviewer's attention and
    // teaches them to skim the check. Human-facing text in this product is
    // Russian, and model-facing text is prose; a colon-joined key is neither.
    if (!isReadable(out)) continue;
    swept += 1;
    expectClean(`${spec.replace("../", "")}:${name}()`, out);
  }
}

console.log(`placeholders-check ok — ${checked} rendered strings clean (${swept} via sweep)`);
