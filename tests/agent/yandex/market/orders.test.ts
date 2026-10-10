import { describe, expect, it } from "vitest";
import {
  marketOrderOperation,
  marketOrdersOperation,
} from "@agent/lib/yandex/market/orders";
import { fixturePage, okData, runOnPage, signedInState } from "./page";

describe("market.orders", () => {
  it("lists the orders with status, delivery method and items, without addresses", async () => {
    const { data } = await okData(
      marketOrdersOperation,
      { status: "completed" },
      (request) =>
        request.path === "/my/orders?filter=COMPLETED"
          ? { body: fixturePage("orders.json") }
          : undefined
    );
    expect(data).toEqual({
      count: 3,
      orders: [
        {
          delivery: "ПВЗ",
          items: ["Тестовая маска для лица, 50 мл"],
          orderIds: ["111222333"],
          status: "Получен 28 мая",
        },
        {
          delivery: "Курьером",
          items: ["Тестовый шейкер Nimbus"],
          orderIds: ["111222334"],
          status: "Получен 6 февраля",
        },
        {
          delivery: "Постамат",
          items: ["Тестовый набор для стрижки", "Тестовая насадка"],
          orderIds: ["111222335"],
          status: "Отменён 5 июля",
        },
      ],
      status: "completed",
    });
  });

  it("answers an empty list with no orders", async () => {
    const { data } = await okData(
      marketOrdersOperation,
      { status: "active" },
      (request) =>
        request.path === "/my/orders"
          ? { body: fixturePage("orders.json", "html_empty") }
          : undefined
    );
    expect(data).toEqual({ count: 0, orders: [], status: "active" });
  });

  it("answers signed_out on the sign-in redirect", async () => {
    const { answer } = await runOnPage(marketOrdersOperation, {}, () => ({
      body: "",
      url: "https://passport.yandex.ru/auth",
    }));
    expect(answer).toEqual({ status: "signed_out" });
  });
});

describe("market.order", () => {
  it("reads one order: status, delivery labels, items and totals, without the recipient or the address", async () => {
    const { data } = await okData(
      marketOrderOperation,
      { orderId: "111222333" },
      (request) =>
        request.path === "/my/order/111222333"
          ? { body: fixturePage("order.json") }
          : undefined
    );
    expect(data).toEqual({
      created: "25 мая 2023",
      delivery: ["Пункт выдачи"],
      items: [
        {
          oldPrice: 3290,
          price: 2690,
          qty: 1,
          title: "Тестовая маска для лица, 50 мл",
        },
      ],
      number: "111 222 333",
      orderId: "111222333",
      payment: "Картой онлайн",
      status: "Уже у вас",
      statusNote: "Вы получили 28 мая",
      totals: { delivery: 0, discount: -600, total: 2690 },
    });
    expect(JSON.stringify(data)).not.toContain("Тест Тестович");
    expect(JSON.stringify(data)).not.toContain("Выдуманная");
  });

  it("refuses an order number that is not digits", async () => {
    await expect(
      runOnPage(marketOrderOperation, { orderId: "../cart" }, () => ({
        body: "",
      }))
    ).rejects.toThrow("bad_argument");
  });

  it("fails as not found for an order that is not the person's", async () => {
    await expect(
      runOnPage(marketOrderOperation, { orderId: "999999999" }, () => ({
        body: `<html><body>${signedInState}<div data-auto="order-page"></div></body></html>`,
      }))
    ).rejects.toThrow("not_found");
  });
});
