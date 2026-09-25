import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { listOrders as listOrderRows } from "@db/services/orders";
import { accessScopeForUser } from "@shared/identity/access-scope";

type OrderRow = Awaited<ReturnType<typeof listOrderRows>>[number];

const listOrders = vi.hoisted(() =>
  vi.fn<(...args: Parameters<typeof listOrderRows>) => Promise<OrderRow[]>>(
    () => Promise.resolve([])
  )
);
vi.mock("@db/services/orders", () => ({ listOrders }));

import { listOrdersTool } from "@agent/tools/list_orders";

const principalId = "better-auth:alice";

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: () => {
      throw new Error("The tool does not use a sandbox.");
    },
    getSkill: () => {
      throw new Error("The tool does not use a skill.");
    },
    getToken: () => {
      throw new Error("The tool does not use an inline token provider.");
    },
    requireAuth: (): never => {
      throw new Error("The tool does not require an inline token provider.");
    },
    session: {
      auth: {
        current: {
          attributes: {
            conversationChannel: "eve",
            workspaceId: accessScopeForUser(principalId).workspaceId,
          },
          authenticator: "authjs",
          issuer: "open-instinct",
          principalId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "list_orders",
  } satisfies ToolContext;
}

function orderRow(overrides: Partial<OrderRow>): OrderRow {
  return {
    browserRunId: "run-1",
    createdAt: new Date("2026-09-24T17:00:00.000Z"),
    errand: null,
    id: "order-1",
    items: null,
    merchant: "other",
    merchantOrderId: "L-1",
    pickup: null,
    priceRub: 1512,
    site: null,
    status: "placed",
    title: "Заказ оформлен",
    where: null,
    workspaceId: accessScopeForUser(principalId).workspaceId,
    ...overrides,
  };
}

describe("list_orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the shop by the site its errand ran on, with what the person asked for", async () => {
    // EN D4: an order from any shop but Ozon or WB read «другой магазин».
    listOrders.mockResolvedValue([
      orderRow({
        errand: "заказ продуктов к 20:00",
        site: "https://www.lavka.yandex.ru/moscow",
        where: "Яндекс Лавка (lavka.yandex.ru)",
      }),
      orderRow({
        merchantOrderId: "C-2",
        where: "Купер (kuper.ru)",
      }),
      orderRow({ merchantOrderId: "X-3" }),
      orderRow({
        merchant: "ozon",
        merchantOrderId: "46000123-0001",
        site: "https://www.ozon.ru",
      }),
    ]);

    const result = await listOrdersTool.execute({}, toolContext());
    if (!("orders" in result)) throw new Error("list_orders answers at once.");

    expect(result.orders).toMatchObject([
      {
        errand: "заказ продуктов к 20:00",
        merchant: "lavka.yandex.ru",
        site: "lavka.yandex.ru",
      },
      { errand: undefined, merchant: "Купер (kuper.ru)", site: undefined },
      { merchant: "магазин не записан" },
      { merchant: "Ozon", site: "ozon.ru" },
    ]);
    expect(JSON.stringify(result)).not.toContain("другой магазин");
  });
});
