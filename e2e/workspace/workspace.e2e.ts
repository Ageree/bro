import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("dashboard", { session: "person", tags: ["smoke"] }, () => {
  test("a new person sees the free plan and empty sections", async ({
    app,
    screen,
  }) => {
    await app.open("/workspace");
    await expect(screen.getByRole("heading", "Кабинет")).toBeVisible();

    const limits = screen.getByRole("region", "Лимиты");
    await expect(limits.getByText("Сообщения в день — до 30")).toBeVisible();
    await expect(
      screen.getByRole("region", "Траты без спроса").getByText("Не заданы")
    ).toBeVisible();
    await expect(
      screen.getByRole("region", "Оплаты").getByText("Пока нет оплат.")
    ).toBeVisible();
    await expect(
      screen.getByRole("region", "Часовой пояс").getByText("Europe/Moscow")
    ).toBeVisible();
  });

  test("the main navigation reaches every section", async ({
    agent,
    app,
    browser,
    screen,
  }) => {
    await app.open("/workspace");

    await agent.act("open «Личные данные» from the main navigation");
    await expect(browser).toHaveURL("/personal-info");
    await expect(screen.getByRole("heading", "Личные данные")).toBeVisible();

    await agent.act("open «Сейф» from the main navigation");
    await expect(browser).toHaveURL("/vault");
    await expect(
      screen.getByRole("heading", "Сейф", { level: 1 })
    ).toBeVisible();

    await agent.act("open «Все чаты» from the main navigation");
    await expect(browser).toHaveURL("/chat/history");
    await expect(screen.getByRole("heading", "Все чаты")).toBeVisible();

    await agent.act("go back to «Кабинет» from the main navigation");
    await expect(browser).toHaveURL("/workspace");
  });

  test("«Открыть чат» opens an empty chat", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/workspace");
    await screen.getByRole("button", "Открыть чат").tap();
    await expect(browser).toHaveURL("/chat");
    await expect(screen.getByRole("textbox", "Напиши Bro…")).toBeVisible();
  });
});
