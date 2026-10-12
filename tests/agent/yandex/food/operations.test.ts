import { describe, expect, it } from "vitest";
import { z } from "zod";
import { lavkaAddressesOperation } from "@agent/lib/yandex/food/addresses";
import {
  edaCartOperation,
  edaCartSetOperation,
  lavkaCartOperation,
  lavkaCartSetOperation,
} from "@agent/lib/yandex/food/cart";
import { edaMenuOperation } from "@agent/lib/yandex/food/menu";
import {
  edaOrdersOperation,
  lavkaActiveOperation,
  lavkaOrdersOperation,
} from "@agent/lib/yandex/food/orders";
import { foodOperations } from "@agent/lib/yandex/food/operations";
import {
  edaSearchOperation,
  lavkaSearchOperation,
} from "@agent/lib/yandex/food/search";
import { yandexOperations } from "@agent/lib/yandex/registry";

import { dataOf, fixture, page, pageGlobals, reply } from "./fake-page";

const json = z.json();

const lavkaPage = pageGlobals.parse({
  __PAGE_PROPS__: { csrfToken: "1-2", pageEnv: { cityId: 213 } },
  __REACT_QUERY_STATE__: {
    queries: [
      { queryKey: ["CommonStartup", 37.6208, 55.7539], state: {} },
      {
        queryKey: ["FavoriteAddresses"],
        state: {
          data: [
            {
              address: {
                city: "Москва",
                flat: "10",
                house: "1",
                location: [37.6208, 55.7539],
                street: "Тестовая улица",
              },
            },
          ],
        },
      },
    ],
  },
});

const menu = z.object({ catalog: json, menu: json }).parse(fixture("eda-menu"));
const coordinates = { lat: 55.7539, lon: 37.6208 };

const cartLine = (
  id: number,
  itemId: number,
  name: string,
  price: number,
  quantity: number
) => ({ id, item_id: itemId, name, price, quantity });

const cartAnswer = (
  items: ReturnType<typeof cartLine>[],
  subtotal: string,
  total: string
) => ({
  cart: {
    items,
    decimal_delivery_fee: "309",
    decimal_subtotal: subtotal,
    decimal_total: total,
  },
});

describe("the food operations", () => {
  it("only read, except the cart changes, and are in the registry", () => {
    expect(foodOperations).toHaveLength(11);
    for (const operation of foodOperations) {
      expect(operation.access).toBe(
        operation === edaCartSetOperation || operation === lavkaCartSetOperation
          ? "cart"
          : "read"
      );
      expect(yandexOperations).toContain(operation);
    }
    expect(yandexOperations.map((operation) => operation.id)).toEqual(
      expect.arrayContaining([
        "food.eda_orders",
        "food.lavka_orders",
        "food.lavka_active",
        "food.lavka_addresses",
        "food.eda_search",
        "food.lavka_search",
        "food.eda_menu",
        "food.eda_cart",
        "food.eda_cart_set",
        "food.lavka_cart",
        "food.lavka_cart_set",
      ])
    );
  });

  it("reads the Eda orders, grocery ones included, without courier or address", async () => {
    const data = await dataOf(
      edaOrdersOperation,
      page([
        { body: fixture("eda-orders"), path: "/eats/v1/orders-info/v1/orders" },
      ]),
      { limit: 10 }
    );
    expect(JSON.stringify(data)).toContain('"service":"lavka"');
    expect(JSON.stringify(data)).not.toMatch(/courier|address|phone/iu);
  });

  it("reads the Lavka orders with their items", async () => {
    const data = await dataOf(
      lavkaOrdersOperation,
      page(
        [
          {
            body: fixture("lavka-orders"),
            path: "/api/v1/orders/v1/history/list",
          },
        ],
        lavkaPage
      ),
      { limit: 10 }
    );
    expect(JSON.stringify(data)).toContain('"orderNr"');
    expect(JSON.stringify(data)).not.toMatch(/courier|destination/iu);
  });

  it("counts the active Lavka orders", async () => {
    const data = await dataOf(
      lavkaActiveOperation,
      page(
        [
          {
            body: fixture("lavka-tracked-orders"),
            path: "/api/v1/providers/orders-tracking/v1/tracked-orders",
          },
        ],
        lavkaPage
      )
    );
    expect(data).toEqual({ activeCount: 0 });
  });

  it("gives the saved Lavka addresses with their coordinates, without the flat", async () => {
    const data = await dataOf(lavkaAddressesOperation, page([], lavkaPage));
    expect(data).toEqual({
      addresses: [
        {
          city: "Москва",
          house: "1",
          lat: 55.7539,
          lon: 37.6208,
          street: "Тестовая улица",
        },
      ],
    });
  });

  it("searches Eda's places at the coordinates given", async () => {
    const data = await dataOf(
      edaSearchOperation,
      page([
        {
          body: fixture("eda-search"),
          path: "/eats/v1/full-text-search/v1/search",
        },
      ]),
      { limit: 10, query: "пицца", ...coordinates }
    );
    expect(JSON.stringify(data)).toContain('"slug":"test_pizza_place"');
    expect(JSON.stringify(data)).toContain('"rating":"4.5 (1600+)"');
  });

  it("searches Lavka's products at the chosen address", async () => {
    const data = await dataOf(
      lavkaSearchOperation,
      page(
        [
          {
            body: fixture("lavka-search"),
            path: "/api/v1/providers/search/v3/lavka",
          },
        ],
        lavkaPage
      ),
      { limit: 10, query: "молоко" }
    );
    expect(data).toMatchObject({ found: 2 });
    expect(JSON.stringify(data)).toContain('"price":91');
  });

  it("reads a place's menu with its delivery terms", async () => {
    const data = await dataOf(
      edaMenuOperation,
      page([
        { body: menu.menu, path: "/api/v2/menu/retrieve/test_pizza_place" },
        { body: menu.catalog, path: "/api/v2/catalog/test_pizza_place" },
      ]),
      { slug: "test_pizza_place", ...coordinates }
    );
    expect(data).toMatchObject({ place: { name: "Тестовая пиццерия" } });
    expect(JSON.stringify(data)).toContain('"name":"Пицца Маргарита"');
  });

  it("says so when the place is unknown", async () => {
    const answer = await reply(
      edaMenuOperation,
      page([{ body: [], path: "/api/v2/menu/retrieve/nope", status: 404 }]),
      { slug: "nope", ...coordinates }
    );
    expect(answer).toEqual({
      data: { error: "place_not_found" },
      status: "ok",
    });
  });

  it("reads the Eda and Lavka carts", async () => {
    expect(
      await dataOf(
        edaCartOperation,
        page([
          { body: fixture("eda-cart"), path: "/eats/v1/cart/v2/multi-carts" },
        ]),
        coordinates
      )
    ).toEqual({ carts: 0 });
    expect(
      await dataOf(
        lavkaCartOperation,
        page(
          [
            {
              body: fixture("lavka-cart"),
              path: "/api/v1/providers/cart/v1/retrieve",
            },
          ],
          lavkaPage
        )
      )
    ).toMatchObject({ blocker: "cart_empty", canCheckout: false, items: [] });
  });

  it("sets Lavka quantities on the current cart version and answers the new cart", async () => {
    const updated = {
      ...z.record(z.string(), json).parse(fixture("lavka-cart")),
      availableForCheckout: true,
      checkoutUnavailableReason: null,
      items: [{ id: "p1", price: "45", quantity: "2", title: "Поп\u00adкорн" }],
      totalItemsCount: 2,
    };
    const data = await dataOf(
      lavkaCartSetOperation,
      page(
        [
          {
            body: {
              ...z.record(z.string(), json).parse(fixture("lavka-cart")),
              nextIdempotencyToken: "token-1",
            },
            path: "/api/v1/providers/cart/v1/retrieve",
          },
          { body: updated, path: "/api/v1/providers/cart/v1/update" },
        ],
        lavkaPage
      ),
      { items: [{ id: "p1", price: 45, quantity: 2 }] }
    );
    expect(data).toMatchObject({
      canCheckout: true,
      items: [{ id: "p1", name: "Попкорн", price: 45, qty: 2 }],
    });
  });

  it("sets Eda dish quantities with the site's requests: PUT for a dish in the cart, add for a new one", async () => {
    const eda = page([
      {
        body: cartAnswer(
          [cartLine(9062519531, 3025138918, "Самса ", 200, 1)],
          "200",
          "509"
        ),
        path: "/eats/v1/cart/v2/full-carts",
      },
      {
        body: cartAnswer(
          [cartLine(9062519531, 3025138918, "Самса ", 200, 2)],
          "400",
          "709"
        ),
        path: "/api/v1/cart/9062519531",
      },
      {
        body: cartAnswer(
          [
            cartLine(9062519531, 3025138918, "Самса ", 200, 2),
            cartLine(9062520000, 3029100650, "Плов", 550, 1),
          ],
          "950",
          "1259"
        ),
        path: "/api/v1/cart/add_bulk",
      },
    ]);
    const data = await dataOf(edaCartSetOperation, eda, {
      items: [
        { id: 3025138918, quantity: 2 },
        { id: 3029100650, quantity: 1 },
      ],
      lat: 55.695511,
      lon: 37.485725,
      place: "doner24_mqn27",
    });
    expect(data).toEqual({
      deliveryFee: 309,
      items: [
        { itemId: 3025138918, name: "Самса", price: 200, quantity: 2 },
        { itemId: 3029100650, name: "Плов", price: 550, quantity: 1 },
      ],
      subtotal: 950,
      total: 1259,
    });
  });

  it("removes an Eda dish set to 0 with DELETE and answers the emptied cart", async () => {
    const eda = page([
      {
        body: {
          cart: {
            items: [
              {
                id: 9062519531,
                item_id: 3025138918,
                name: "Самса",
                price: 200,
                quantity: 1,
              },
            ],
            decimal_delivery_fee: "0",
            decimal_subtotal: "200",
            decimal_total: "200",
          },
        },
        path: "/eats/v1/cart/v2/full-carts",
      },
      {
        body: {
          cart: {
            items: [],
            decimal_delivery_fee: "0",
            decimal_subtotal: "0",
            decimal_total: "0",
          },
        },
        path: "/api/v1/cart/9062519531",
      },
    ]);
    expect(
      await dataOf(edaCartSetOperation, eda, {
        items: [{ id: 3025138918, quantity: 0 }],
        lat: 55.695511,
        lon: 37.485725,
        place: "doner24_mqn27",
      })
    ).toEqual({ deliveryFee: 0, items: [], subtotal: 0, total: 0 });
  });

  it("answers signed_out when the service says the person is not signed in", async () => {
    const eda = page([
      { body: {}, path: "/eats/v1/orders-info/v1/orders", status: 401 },
    ]);
    expect(await reply(edaOrdersOperation, eda)).toEqual({
      status: "signed_out",
    });
    const lavka = page(
      [{ body: {}, path: "/api/v1/orders/v1/history/list", status: 401 }],
      lavkaPage
    );
    expect(await reply(lavkaOrdersOperation, lavka, { limit: 10 })).toEqual({
      status: "signed_out",
    });
  });
});

describe("Lavka read operations on a light page", () => {
  const embedded = (id: string, value: unknown) =>
    `<script id="${id}" type="mime/invalid" nonce="x">${JSON.stringify(value)}</script>`;

  it("read the page state from the home page's embedded JSON when the page has none", async () => {
    const home = [
      embedded("__page_props__-data", lavkaPage.__PAGE_PROPS__),
      embedded("__react_query_state__-data", lavkaPage.__REACT_QUERY_STATE__),
    ].join("<script>other()</script>");
    const context = page([{ body: null, path: "/", text: home }]);
    expect(await dataOf(lavkaAddressesOperation, context)).toEqual(
      await dataOf(lavkaAddressesOperation, page([], lavkaPage))
    );
  });

  it("answer a captcha when Lavka sends a check instead of its page", async () => {
    const context = page([{ body: null, path: "/", status: 429 }]);
    expect(await reply(lavkaAddressesOperation, context)).toEqual({
      status: "captcha",
    });
  });
});
