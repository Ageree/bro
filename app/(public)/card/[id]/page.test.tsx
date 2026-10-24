import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readCardByLink } from "@db/services/cards";
import { cardSchema } from "@shared/cards/schema";

const services = vi.hoisted(() => ({
  read: vi.fn<typeof readCardByLink>(),
}));

vi.mock("@db/services/cards", () => ({ readCardByLink: services.read }));

const { default: CardPage } = await import("@app/(public)/card/[id]/page");

const link = "A".repeat(43);

async function page() {
  const element = await CardPage({
    params: Promise.resolve({ id: link }),
    searchParams: Promise.resolve({}),
  });
  return parseHTML(renderToStaticMarkup(element)).document;
}

beforeEach(() => {
  services.read.mockReset();
});

describe("the card's page", () => {
  it("starts the card 16 px under Telegram's own header, with no capsule of its own", async () => {
    services.read.mockResolvedValue({
      card: cardSchema.parse({
        blocks: [{ text: "Рейс в Казань", type: "text" }],
        title: "Рейс",
      }),
      conversationChannel: "telegram",
      conversationId: "4242::",
      createdAt: new Date(),
      id: link,
      revision: 1,
      updatedAt: new Date(),
      userId: "user-1",
      workspaceId: "workspace:user-1",
    });
    const document = await page();

    expect(document.querySelector("nav")).toBeNull();
    expect(document.body.textContent).not.toContain("bro.");
    const main = document.querySelector("main");
    expect(main?.className).toContain("pt-4");
    expect(main?.className).not.toContain("pt-[5.5rem]");
    expect(document.querySelector("article h1")?.textContent).toBe("Рейс");
  });

  it("says a card that expired or never was is gone, as close under the header", async () => {
    services.read.mockResolvedValue(undefined);
    const document = await page();

    expect(document.querySelector("nav")).toBeNull();
    expect(document.querySelector("main")?.className).toContain("pt-4");
    expect(document.querySelector("h1")?.textContent).toBe(
      "Карточка устарела или не найдена"
    );
  });
});
