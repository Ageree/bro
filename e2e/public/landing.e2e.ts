import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("public pages", { tags: ["smoke"] }, () => {
  test("the landing introduces Bro and leads to the sign-in", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    // The heading is for screen readers only (`sr-only`).
    await expect(
      screen.getByRole("heading", "bro — твой личный ИИ-агент", { level: 1 })
    ).toBeAttached();

    await screen
      .getByRole("navigation", "Служебные страницы")
      .getByRole("link", "Кабинет")
      .tap();
    await expect(browser).toHaveURL("/sign-in");
    await expect(screen.getByRole("heading", "Вход")).toBeVisible();
  });

  test("the offer opens from the landing", async ({ app, browser, screen }) => {
    await app.open("/");
    await screen.getByRole("link", "Оферта").tap();
    await expect(browser).toHaveURL("/oferta");
    await expect(screen.getByRole("heading", "Публичная оферта")).toBeVisible();
  });

  test("a private page sends a stranger to the sign-in", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/vault");
    await expect(browser).toHaveURL(/\/sign-in\?callbackUrl=%2Fvault$/u);
    await expect(screen.getByRole("heading", "Вход")).toBeVisible();
  });
});
