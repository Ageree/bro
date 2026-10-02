import { expect } from "e2e";
import { ownPersonTest } from "../person.ts";
import { chatLog, sendToBro } from "./bro.ts";

/**
 * agent/instructions/content/role/interactive.md, «Первый контакт»: a first
 * message that carries a task gets a short introduction and then the task,
 * in the same turn. A bare question, with no greeting, is the case that
 * fails.
 */
ownPersonTest(
  "a new person's first question is answered after the introduction",
  {
    skip: "Known defect: a bare first question gets only the introduction (docs/e2e.md)",
    tags: ["agent"],
    timeout: 300_000,
  },
  async ({ agent, app, screen }) => {
    await app.open("/chat");
    await sendToBro(
      screen,
      "Как называется столица Франции? Ответь одним словом."
    );

    await expect(chatLog(screen)).toContainText("Париж");
    await agent.assert("Bro introduced itself in the chat log");
  }
);
