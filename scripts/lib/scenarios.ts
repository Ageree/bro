/**
 * What a cloud run actually checks.
 *
 * Two rules keep these from rotting. First, an expectation anchors on a
 * constant the product already owns — a fragment of `welcomeBubbles()`, the
 * canned failure line — rather than on a sentence retyped here, so a wording
 * change moves both sides at once instead of turning the suite red for no
 * reason. Second, anything the model phrases freely is asserted loosely (it
 * answered at all; it did not repeat the letter), because pinning a language
 * model to an exact sentence tests the sampler, not the product.
 */
import { welcomeBubbles } from "../../agent/lib/onboard-policy.ts";
import { humanLineForNeed } from "../../convex/lib/browserOutcomePolicy.ts";

export type Check =
  /** Some bubble contains this. */
  | { says: string | RegExp }
  /** No bubble contains this. */
  | { never: string | RegExp }
  /** At least one bubble arrived. */
  | { replies: true }
  /** Nothing arrived at all. */
  | { silent: true };

export type Turn = {
  /** What the human texts. */
  text: string;
  expect: Check[];
  /**
   * How long to keep waiting for more bubbles after the last one arrived.
   * The default suits a plain chat turn; a turn that starts a tool run needs
   * longer before "nothing more is coming" is true.
   */
  settleMs?: number;
};

export type Scenario = {
  name: string;
  about: string;
  /** Env flags that must be set, or the scenario is skipped with a reason. */
  needs?: string[];
  turns: Turn[];
};

/** A line from the welcome letter distinctive enough to detect it by. */
const LETTER = welcomeBubbles()[0]!;

export const SCENARIOS: Scenario[] = [
  {
    name: "onboard-letter",
    about:
      "The letter is a first-contact thing: once on the bind, never again for a plain «привет». " +
      "This is the regression test for the bug fixed in #107 — before it, every greeting re-sent the letter.",
    turns: [
      {
        text: "привет",
        expect: [{ says: LETTER }],
      },
      {
        text: "привет",
        // The second greeting must be answered like a greeting, not with the
        // letter again. Both halves matter: a silent turn would also pass
        // `never` on its own.
        expect: [{ never: LETTER }, { replies: true }],
      },
    ],
  },
  {
    name: "help-letter",
    about: "Asking what Bro can do brings the letter back, unlike a bare greeting.",
    turns: [
      { text: "привет", expect: [{ says: LETTER }] },
      { text: "что ты умеешь?", expect: [{ says: LETTER }] },
    ],
  },
  {
    name: "never-silent",
    about:
      "A human turn never ends in silence. Small talk has no tool to call and no " +
      "policy branch to hit, so it is the turn most likely to come back empty.",
    turns: [
      { text: "привет", expect: [{ says: LETTER }] },
      { text: "спасибо, бро", expect: [{ replies: true }] },
      { text: "а ты умеешь считать? сколько будет 17 на 3", expect: [{ says: /51/ }] },
    ],
  },
  {
    name: "telegram-invite",
    about: "«телеграм» hands over a t.me bind link rather than explaining what Telegram is.",
    // Without a bot username there is no link to mint, and `sendTelegramInvite`
    // correctly answers «Telegram у Bro ещё не включён». That is right behaviour
    // for an unconfigured deployment, so it must skip rather than go red — a
    // failure that only means "this deployment has no Telegram" teaches the
    // reader to ignore red. Like `BRO_E2E_FAKE_BROWSER`, the variable is read
    // on the RUNNER and is the operator asserting what the deployment carries;
    // the runner cannot see the eve process's own env.
    needs: ["TELEGRAM_BOT_USERNAME"],
    turns: [
      { text: "привет", expect: [{ says: LETTER }] },
      { text: "телеграм", expect: [{ says: /t\.me\// }] },
    ],
  },
  {
    name: "memory",
    about:
      "A fact told in one turn survives into the next one. This exercises the memo " +
      "slot end to end — the tool call, the Convex write, and the recall before the next turn.",
    turns: [
      { text: "привет", expect: [{ says: LETTER }] },
      {
        text: "запомни: мой размер обуви 43, пункт выдачи на Ленина 5",
        expect: [{ replies: true }],
        settleMs: 6000,
      },
      { text: "какой у меня размер обуви?", expect: [{ says: /43/ }], settleMs: 6000 },
    ],
  },
];

/**
 * Browser errands, against `scripts/fake-browser-use.ts`.
 *
 * Skipped unless `BRO_E2E_FAKE_BROWSER` is set, which is the runner's way of
 * being told that the deployment it is driving has `BROWSER_USE_BASE_URL`
 * pointed at the fake. Run against the real Browser Use they would buy things
 * and take minutes, so they are opt-in rather than on by default.
 *
 * The settle windows are long because the answer does not come back on the
 * turn that started the errand: the run finishes later and the result reaches
 * the human through follow-through polling and a wakeup. That gap is the
 * whole point — it is where Bro has historically gone quiet — and the
 * recorder catches it because the sink sits in the shared delivery funnel.
 */
const BROWSER_SCENARIOS: Scenario[] = [
  {
    name: "buy",
    about:
      "An errand that completes reaches the human with the order, without being asked again.",
    needs: ["BRO_E2E_FAKE_BROWSER"],
    turns: [
      { text: "привет", expect: [{ says: LETTER }] },
      {
        text: "купи молоко на wildberries",
        // The order number comes from the fake's labelled block, so this also
        // proves the outcome survived parsing, the wakeup and the reply.
        expect: [{ says: "4815162342" }],
        settleMs: 30_000,
      },
    ],
  },
  {
    name: "pay-3ds",
    about:
      "A run parked on the bank hands over a live-view link and never asks for a password in chat.",
    needs: ["BRO_E2E_FAKE_BROWSER"],
    turns: [
      { text: "привет", expect: [{ says: LETTER }] },
      {
        text: "оплати заказ и подтверди в банке",
        expect: [
          { says: humanLineForNeed("3ds").split("—")[0]!.trim() },
          { says: /https:\/\// },
          // The standing rule: a password is never asked for in the thread.
          { never: /парол/i },
        ],
        settleMs: 30_000,
      },
    ],
  },
];

SCENARIOS.push(...BROWSER_SCENARIOS);

export function scenarioByName(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
