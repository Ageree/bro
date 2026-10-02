import { expect } from "e2e";
import { ownPersonTest } from "../person.ts";
import { chatLog, sendToBro } from "./bro.ts";

/** Shorter than any introduction: who Bro is and what it can do. */
const introductionLength = 60;

/**
 * agent/instructions/content/role/interactive.md, «Первый контакт»: a first
 * message that carries a task gets a short introduction and then the task,
 * in the same turn. A bare question, with no greeting, is the case that
 * failed: the introduction used up the turn's message limit and counted as
 * the reply (`firstContactTurn` in agent/lib/delivery/first-contact.ts).
 */
ownPersonTest(
  "a new person's first question is answered after the introduction",
  {
    tags: ["agent"],
    timeout: 300_000,
  },
  async ({ app, browser, screen }) => {
    await app.open("/chat");
    const reply = await sendToBro(
      { browser, screen },
      "Как называется столица Франции? Ответь одним словом."
    );

    await expect(chatLog(browser)).toContainText("Париж");
    // The introduction comes first: a few sentences before the answer. Not
    // a judge: the log does not say whose message is whose, and the model
    // read the bubbles out of order.
    expect(reply.slice(0, reply.indexOf("Париж")).length).toBeGreaterThan(
      introductionLength
    );
  }
);
