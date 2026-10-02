import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { ownPersonTest as test } from "../person.ts";

describe("personal info", { tags: ["smoke"] }, () => {
  test("saved details survive a reload", async ({ app, screen }) => {
    await app.open("/personal-info");
    await screen.getByLabel("Имя").fill("Анна");
    await screen.getByLabel("Город").fill("Казань");
    await screen.getByRole("button", "Сохранить").tap();
    await expect(screen.getByText("Сохранено.")).toBeVisible();

    await app.open("/personal-info");
    await expect(screen.getByLabel("Имя")).toHaveValue("Анна");
    await expect(screen.getByLabel("Город")).toHaveValue("Казань");
  });

  test("a new time zone reaches the dashboard", async ({ app, screen }) => {
    // Exact steps: deepseek-v4.1-flash filled this combobox (an input with a
    // datalist) but then left the form unsaved in 1 of 3 runs.
    await app.open("/personal-info");
    await screen
      .getByRole("combobox", "Часовой пояс")
      .fill("Asia/Yekaterinburg");
    await screen.getByRole("button", "Сохранить").tap();
    await expect(screen.getByText("Сохранено.")).toBeVisible();

    await app.open("/workspace");
    await expect(
      screen.getByRole("region", "Часовой пояс").getByText("Asia/Yekaterinburg")
    ).toBeVisible();
  });

  test("a malformed email is refused", async ({ app, screen }) => {
    await app.open("/personal-info");
    await screen.getByLabel("Почта").fill("not-an-email");
    await screen.getByRole("button", "Сохранить").tap();
    await expect(
      screen.getByText("Не сохранилось.", { exact: false })
    ).toBeVisible();
  });
});
