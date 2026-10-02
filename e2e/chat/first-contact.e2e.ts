import { expect } from "e2e";
import { ownPersonTest } from "../person.ts";
import { chatLog, sendToBro } from "./bro.ts";

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
  async ({ agent, app, browser, screen }) => {
    await app.open("/chat");
    await sendToBro(
      { browser, screen },
      "Как называется столица Франции? Ответь одним словом."
    );

    await expect(chatLog(browser)).toContainText("Париж");
    await agent.assert(
      "before its answer Bro introduced itself in the chat log: who it is or what it can do for the person"
    );
  }
);
