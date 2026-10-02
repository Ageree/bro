import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { sendToBro } from "../chat/bro.ts";
import { ownPersonTest } from "../person.ts";

describe("memory", { tags: ["smoke"] }, () => {
  ownPersonTest(
    "a new person's memory is empty until the first conversation",
    async ({ app, screen }) => {
      await app.open("/workspace");
      await screen
        .getByRole("region", "Память")
        .getByRole("link", "открыть память")
        .tap();
      await expect(
        screen.getByRole("heading", "Память", { level: 1 })
      ).toBeVisible();
      await expect(
        screen.getByText("Записи появятся после первого разговора с Бро.")
      ).toBeVisible();
    }
  );
});

describe("memory with Bro", { tags: ["agent"], timeout: 420_000 }, () => {
  /**
   * Item 31: the person sees what Bro remembers, corrects it, brings the
   * earlier text back from its history and forgets it — and a one-time code
   * said in the chat never shows up there.
   */
  ownPersonTest(
    "the person corrects, restores and forgets what Bro remembered",
    async ({ app, browser, screen }) => {
      await app.open("/chat");
      await sendToBro({ browser, screen }, "Привет!");
      await sendToBro({ browser, screen }, "Запомни: я не ем свинину.");
      await sendToBro(
        { browser, screen },
        "Запомни ещё код из смс для входа в Госуслуги: 482193."
      );

      await app.open("/workspace/memory");
      const remembered = screen.getByRole("button", {
        name: /^Изменить: .*свинин/iu,
      });
      await expect(remembered).toBeVisible();
      await expect(screen.getByText(/482193/u)).toHaveCount(0);

      // Exact steps: what is saved and restored must be this very text.
      await remembered.tap();
      const edit = screen.getByRole("dialog", "Изменить запись");
      await edit.getByLabel("Текст записи").fill("Не ест свинину и баранину.");
      await edit.getByRole("button", "Сохранить").tap();
      await expect(edit).toBeHidden();
      // The row's own buttons: the timeline shows the text too.
      await expect(
        screen.getByRole("button", "История: Не ест свинину и баранину.")
      ).toBeVisible();

      await screen
        .getByRole("button", "История: Не ест свинину и баранину.")
        .tap();
      const history = screen.getByRole("dialog", "История записи");
      await history.getByRole("button", { name: /^Вернуть: / }).first().tap();
      await expect(history).toBeHidden();
      await expect(
        screen.getByRole("button", "История: Не ест свинину и баранину.")
      ).toHaveCount(0);
      await expect(
        screen.getByRole("button", { name: /^История: .*свинин/iu })
      ).toBeVisible();

      await screen.getByRole("button", { name: /^Удалить: .*свинин/iu }).tap();
      await expect(
        screen.getByRole("button", { name: /^Удалить: .*свинин/iu })
      ).toHaveCount(0);
    }
  );
});
