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

export function scenarioByName(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
