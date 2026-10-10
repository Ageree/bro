import { z } from "zod";
import { defineYandexOperation } from "../operations";

/**
 * The delivery addresses saved in the person's Lavka account. Yandex Eda
 * does not keep an address of the account, so the coordinates for
 * `food.eda_search` and `food.eda_menu` come from here.
 */
export const lavkaAddressesOperation = defineYandexOperation({
  about:
    "The delivery addresses saved in the person's Yandex Lavka account, with their coordinates. Use lat and lon from here as the location for food.eda_search, food.eda_menu and food.eda_cart: Yandex Eda does not know the person's address. Takes no arguments.",
  access: "read",
  args: z.object({}),
  id: "food.lavka_addresses",
  origin: "https://lavka.yandex.ru/",
  result: z.object({
    addresses: z.array(
      z.object({
        city: z.string(),
        house: z.string(),
        lat: z.number(),
        lon: z.number(),
        street: z.string(),
      })
    ),
  }),
  // The saved addresses are in the page's query state, which the page
  // fills when it loads; no request is made for them.
  run: `async function () {
  const queries = window.__REACT_QUERY_STATE__.queries;
  const favorites = queries.find((entry) => entry.queryKey[0] === "FavoriteAddresses");
  const saved = favorites && favorites.state.data ? favorites.state.data : [];
  const addresses = saved.map((entry) => {
    const address = entry.address;
    return {
      city: address.city,
      street: address.street,
      house: address.house,
      lon: Number(address.location[0]),
      lat: Number(address.location[1]),
    };
  });
  return { status: "ok", data: { addresses } };
}`,
  service: "yandex-lavka",
});
