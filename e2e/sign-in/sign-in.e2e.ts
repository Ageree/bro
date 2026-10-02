import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { newPhone, signIn } from "../person.ts";

describe("sign-in", { tags: ["smoke"] }, () => {
  test("a new person signs in by phone and sees the dashboard", async ({
    app,
    browser,
    screen,
  }) => {
    const phone = newPhone();
    await app.open("/sign-in");
    await signIn({ browser, screen }, phone);

    await expect(screen.getByRole("heading", "Кабинет")).toBeVisible();
    await expect(screen.getByText(phone)).toBeVisible();
    await expect(
      screen.getByText(`Бесплатный режим · Телефон …${phone.slice(-4)}`)
    ).toBeVisible();
  });

  test("the sign-in returns to the page that asked for it", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/vault");
    await expect(browser).toHaveURL(/\/sign-in\?callbackUrl=%2Fvault$/u);
    await signIn({ browser, screen }, newPhone(), "/vault");
    await expect(
      screen.getByRole("heading", "Сейф", { level: 1 })
    ).toBeVisible();
  });

  test("a number that is not a phone is refused", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/sign-in");
    await screen.getByLabel("Телефон").fill("12");
    await screen.getByRole("button", "Войти").tap();

    await expect(screen.getByText("Введи номер телефона.")).toBeVisible();
    await expect(browser).toHaveURL("/sign-in");
  });

  test("signing out closes the dashboard", async ({ app, browser, screen }) => {
    await app.open("/sign-in");
    await signIn({ browser, screen }, newPhone());

    await screen.getByRole("button", "Выйти").tap();
    await expect(browser).toHaveURL("/sign-in");

    await app.open("/workspace");
    await expect(browser).toHaveURL(/\/sign-in\?callbackUrl=%2Fworkspace$/u);
  });
});
