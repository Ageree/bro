import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import hotelChoice from "../../../../../../docs/cards/examples/hotel-choice.json";
import type * as Cards from "@db/services/cards";
import type * as Identities from "@db/services/channel-identities";
import type * as z from "zod";
import {
  respondReplySchema,
  type respondRequestSchema,
} from "@shared/cards/respond";
import type { cardDraftSchema } from "@shared/cards/response";
import { cardSchema } from "@shared/cards/schema";

const mocks = vi.hoisted(() => ({
  account: vi.fn<typeof Identities.channelAccountScope>(),
  count: vi.fn<typeof Cards.countCardResponses>(),
  read: vi.fn<typeof Cards.readCardByLink>(),
  response: vi.fn<typeof Cards.readCardResponse>(),
  save: vi.fn<typeof Cards.saveCardResponse>(),
}));

vi.mock("@db/services/cards", () => ({
  countCardResponses: mocks.count,
  readCardByLink: mocks.read,
  readCardResponse: mocks.response,
  saveCardResponse: mocks.save,
}));
vi.mock("@db/services/channel-identities", () => ({
  channelAccountScope: mocks.account,
}));

const id = "A".repeat(43);
const token = "123456:test-bot-token";
const alice = { userId: "better-auth:alice", workspaceId: "workspace:alice" };
const hotel = cardSchema.parse(hotelChoice);
const card = {
  card: hotel,
  conversationChannel: "telegram" as const,
  conversationId: "4242::",
  createdAt: new Date(Date.now() - 60_000),
  id,
  revision: 1,
  updatedAt: null,
  ...alice,
};
const answer = { action: "continue", values: { hotel: "nevsky_dvor" } };

/** Launch data as Telegram signs it for a Mini App Bro's button opened. */
function launchData(userId: number, botToken = token) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId }),
  };
  const checked = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(checked).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function post(
  body: z.input<typeof respondRequestSchema>,
  origin = "https://example.com"
) {
  vi.resetModules();
  const { POST } = await import("@app/api/cards/[id]/respond/route");
  const response = await POST(
    new Request(`https://example.com/api/cards/${id}/respond`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }),
    { params: Promise.resolve({ id }) }
  );
  return {
    body: respondReplySchema.parse(await response.json()),
    status: response.status,
  };
}

const send = (
  values: z.infer<typeof cardDraftSchema>,
  initData = launchData(4242)
) => post({ action: "continue", initData, kind: "send", revision: 1, values });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", token);
  vi.stubEnv("CARDS_WORKSPACES", "workspace:alice");
  mocks.read.mockResolvedValue(card);
  mocks.account.mockImplementation(async (_channel, telegramUserId) =>
    telegramUserId === "4242" ? alice : undefined
  );
  mocks.response.mockResolvedValue(undefined);
  mocks.count.mockResolvedValue(0);
  mocks.save.mockResolvedValue({
    answer,
    outcome: "received",
    state: "received",
  });
});

describe("a card's answer from its page", () => {
  it("is taken from the person the card was sent to, and kept with what Bro reads", async () => {
    expect(await send({ extras: ["parking"], hotel: "nevsky_dvor" })).toEqual({
      body: { answer, delivery: "received", status: "sent" },
      status: 200,
    });
    expect(mocks.save).toHaveBeenCalledOnce();
    const [kept, response] = mocks.save.mock.calls[0] ?? [];
    expect(kept).toBe(card);
    expect(response).toMatchObject({
      answer: {
        action: "continue",
        values: { extras: ["parking"], hotel: "nevsky_dvor" },
      },
      telegramUserId: "4242",
    });
    expect(response?.summary).toBe(
      [
        "Отель: Невский Двор",
        "Что нужно дополнительно: Парковка",
        "Пожелание к номеру: не заполнено",
        "Нажал: «Продолжить с выбором»",
      ].join("\n")
    );
  });

  it("tells the person whether the card is theirs to answer, and shows only them the answer", async () => {
    const open = (userId: number) =>
      post({ initData: launchData(userId), kind: "open", revision: 1 });

    expect(await open(4242)).toEqual({ body: { status: "open" }, status: 200 });
    mocks.response.mockResolvedValue({ ...answer, state: "delivered" });
    expect(await open(4242)).toEqual({
      body: { answer, delivery: "delivered", status: "sent" },
      status: 200,
    });
    expect(await open(777)).toEqual({
      body: { status: "foreign" },
      status: 403,
    });
  });

  it("turns away another site, unsigned or forged launch data, and someone else", async () => {
    expect(
      await post(
        {
          action: "continue",
          initData: launchData(4242),
          kind: "send",
          revision: 1,
          values: answer.values,
        },
        "https://evil.example"
      )
    ).toEqual({ body: { status: "refused" }, status: 403 });
    expect(await send(answer.values, "")).toEqual({
      body: { status: "unverified" },
      status: 403,
    });
    expect(
      await send(answer.values, launchData(4242, "999:other"))
    ).toMatchObject({ body: { status: "unverified" } });
    expect(await send(answer.values, launchData(777))).toMatchObject({
      body: { status: "foreign" },
      status: 403,
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("takes nothing for a card gone, out of the pilot, or changed since the page loaded", async () => {
    mocks.read.mockResolvedValueOnce(undefined);
    expect(await send(answer.values)).toMatchObject({ status: 404 });
    vi.stubEnv("CARDS_WORKSPACES", "workspace:bob");
    expect(await send(answer.values)).toMatchObject({
      body: { status: "closed" },
    });
    vi.stubEnv("CARDS_WORKSPACES", "*");
    mocks.read.mockResolvedValue({ ...card, revision: 2 });
    expect(await send(answer.values)).toEqual({
      body: { status: "stale" },
      status: 409,
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("says what to fix, by the question, and keeps nothing", async () => {
    expect(await send({ hotel: "ritz", wish: "x" })).toEqual({
      body: {
        issues: [{ id: "hotel", message: "Такого варианта в карточке нет." }],
        status: "invalid",
      },
      status: 422,
    });
    expect(await send({ guests: "2", hotel: "nevsky_dvor" })).toMatchObject({
      body: { issues: [{ id: null }], status: "invalid" },
      status: 422,
    });
    expect(
      await send({ hotel: "nevsky_dvor", wish: "Карта 4111 1111 1111 1111" })
    ).toEqual({
      body: { id: "wish", kind: "card-number", status: "secret" },
      status: 422,
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("keeps up to ten answers of a workspace in ten minutes", async () => {
    mocks.count.mockResolvedValue(10);
    expect(await send(answer.values)).toEqual({
      body: { status: "busy" },
      status: 429,
    });
    mocks.response.mockResolvedValue({ ...answer, state: "received" });
    mocks.save.mockResolvedValue({
      answer,
      outcome: "repeat",
      state: "received",
    });
    expect(await send(answer.values)).toMatchObject({
      body: { status: "sent" },
      status: 200,
    });
  });

  it("shows the answer kept when another one comes for the same revision", async () => {
    mocks.save.mockResolvedValue({
      answer,
      outcome: "answered",
      state: "delivered",
    });
    expect(await send({ hotel: "admiral" })).toEqual({
      body: { answer, delivery: "delivered", status: "answered" },
      status: 409,
    });
  });
});
