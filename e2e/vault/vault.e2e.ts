import { describe, test } from "@e2e-dev/web";
import { expect, secrets } from "e2e";
import { ownPersonTest } from "../person.ts";
import { testSecrets } from "../secrets.ts";

describe("vault", { tags: ["smoke"] }, () => {
  test(
    "a new person's vault is empty",
    { session: "person" },
    async ({ app, screen }) => {
      await app.open("/vault");
      const saved = screen.getByRole("region", "Сохранённые");
      for (const kind of ["Входы", "Карты", "Адреса", "Контакты"]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one list, read row by row.
        await expect(
          saved.getByRole("button", `${kind} Пока пусто`)
        ).toBeVisible();
      }
    }
  );

  ownPersonTest(
    "a site login is saved without showing its password",
    async ({ app, screen }) => {
      // Exact steps: deepseek-v4.1-flash gave up while «Сохранить» still
      // showed the save in progress. The password goes in as a runner
      // secret all the same, which no model or report sees.
      await app.open("/vault");
      await screen
        .getByRole("region", "Добавить или изменить")
        .getByRole("link", "Добавить вход")
        .tap();
      const form = screen.getByRole("dialog", "Добавить вход");
      await form.getByLabel("Метка").fill("Пример");
      await form.getByLabel("Сайт").fill("example.com");
      await form.getByLabel("Почта").fill("anna@example.com");
      await form
        .getByLabel("Пароль (необязательно)")
        .fill(secrets.get("vault-password"));
      await form.getByRole("button", "Сохранить").tap();
      await expect(form).toBeHidden();

      await app.open("/vault");
      const logins = screen.getByRole("button", { name: /^Входы/u });
      await expect(logins).not.toHaveAccessibleName("Входы Пока пусто");
      await logins.tap();
      // One entry: a save tapped twice must not have made a second.
      await expect(
        screen.getByRole("listitem").filter({ hasText: "example.com" })
      ).toHaveCount(1);
      await expect(screen.getByText(testSecrets["vault-password"])).toHaveCount(
        0
      );
    }
  );
});
