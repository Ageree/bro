import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chatLog, sendToBro } from "./bro.ts";

const question = "Как называется столица Франции? Ответь одним словом.";

/**
 * Bro itself answers here: each test spends a real turn of the app's model.
 * One person's conversation, in order; the greeting comes first so the
 * question meets a Bro already introduced (first-contact.e2e.ts covers the
 * first message).
 */
describe(
  "chat with Bro",
  { serial: true, session: "person", tags: ["agent"], timeout: 300_000 },
  () => {
    test("Bro greets a new person", async ({ agent, app, browser, screen }) => {
      await app.open("/chat");
      await sendToBro({ browser, screen }, "Привет!");

      await expect(browser).toHaveURL(/\/chat\/[\w-]+$/u);
      await agent.assert(
        "below the person's «Привет!» the chat log shows at least one reply from Bro, in Russian"
      );
    });

    test("Bro answers a question in the same conversation", async ({
      app,
      browser,
      screen,
    }) => {
      await app.open("/chat/history");
      await screen
        .getByRole("region", "История")
        .getByRole("link", "Привет!")
        .first()
        .tap();
      await expect(chatLog(browser)).toContainText("Привет!");

      await sendToBro({ browser, screen }, question);
      await expect(chatLog(browser)).toContainText("Париж");
    });

    test("Bro keeps the thread of the conversation", async ({
      agent,
      app,
      browser,
      screen,
    }) => {
      await app.open("/chat/history");
      await screen
        .getByRole("region", "История")
        .getByRole("link", "Привет!")
        .first()
        .tap();
      await expect(chatLog(browser)).toContainText("Париж");

      await sendToBro(
        { browser, screen },
        "А какой самый известный музей в этом городе? Одним словом."
      );
      await expect(chatLog(browser)).toContainText("Лувр");
      await agent.assert(
        "Bro's latest reply names the Louvre and does not ask which city was meant"
      );
    });
  }
);
