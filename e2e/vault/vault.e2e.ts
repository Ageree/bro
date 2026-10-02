import { describe, test } from "@e2e-dev/web";
import { expect, secrets } from "e2e";
import { ownPersonTest } from "../person.ts";

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
    async ({ agent, app, screen }) => {
      await app.open("/vault");
      await agent.act(
        "add a site login for {site} with the login {login} and the password {password}, and save it",
        {
          params: {
            login: "anna@example.com",
            password: secrets.get("vault-password"),
            site: "example.com",
          },
        }
      );

      await app.open("/vault");
      const logins = screen.getByRole("button", { name: /^Входы/u });
      await expect(logins).not.toHaveAccessibleName("Входы Пока пусто");
      await logins.tap();
      await expect(
        screen.getByText("example.com", { exact: false }).first()
      ).toBeVisible();
      await expect(screen.getByText("e2e-vault-password")).toHaveCount(0);
    }
  );
});
