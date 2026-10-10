import { describe, expect, it } from "vitest";
import { z } from "zod";
import { lavkaAddressesOperation } from "@agent/lib/yandex/food/addresses";
import {
  edaCartOperation,
  lavkaCartOperation,
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

describe("the food operations", () => {
  it("are read only, on Yandex's own sites, and in the registry", () => {
    expect(foodOperations).toHaveLength(9);
    for (const operation of foodOperations) {
      expect(operation.access).toBe("read");
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
        "food.lavka_cart",
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
