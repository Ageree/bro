import * as z from "zod";
import { isYandexHost } from "../operations";

/**
 * The hall plan of a session as Yandex Tickets' widget reads it, where
 * Afisha sells: every zone with its prices, and whether it has seats. A zone
 * without seats (a dance floor, «входной», «свободная рассадка») is bought by
 * count, and on the widget's map it is a plain outlined area: 22.10 the
 * browser looked for seats priced 4 200 ₽ in such a zone, found none and told
 * the person that price could not be bought.
 *
 * The widget's own chain, with the anonymous cookie it hands any visitor and
 * nothing of the person's: `yandexuid` from any page of the widget, a token of
 * its antibot check bound to that cookie, then the plan, which it prepares and
 * puts on its CDN.
 */
const widgetOrigin = "https://widget.afisha.yandex.ru";
const userAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** The wait for one request, and for the plan to be ready at all. */
const requestBudgetMs = 5000;
const planBudgetMs = 9000;
/** How often the plan is asked for while the widget prepares it. */
const pollMs = 700;
/** After a refusal the widget is not asked again for this long. */
const coolOffMs = 10 * 60_000;
/** A zone with more prices than this keeps the cheapest and the dearest. */
const pricesShown = 8;

let coolOffUntil = 0;

/** The widget's session keys: base64 of its ids, as Afisha's `ticket.id` gives them. */
const sessionKeyPattern = /^[A-Za-z0-9+/=_-]{8,200}$/u;

const money = z.object({ value: z.number() });
const priceInfoSchema = z.object({
  price: money,
  total: money.nullish(),
});

const planSchema = z.object({
  result: z.object({
    hallplan: z.object({
      categories: z.array(
        z.object({
          id: z.number(),
          priceChanges: z
            .array(
              z.object({ priceInfo: priceInfoSchema, startDate: z.string() })
            )
            .nullish(),
          priceInfos: z.array(priceInfoSchema).nullish(),
        })
      ),
      levels: z.array(
        z.object({
          admission: z.boolean().nullish(),
          availableSeatCount: z.number().nullish(),
          categories: z
            .array(z.object({ id: z.number(), name: z.string().nullish() }))
            .nullish(),
          name: z.string().nullish(),
          prices: z.array(money).nullish(),
        })
      ),
      maxTicketsCount: z.number().nullish(),
      settings: z
        .object({ hideAdmissionAvailableSeatsCount: z.boolean().nullish() })
        .nullish(),
    }),
  }),
});

type Plan = z.output<typeof planSchema>["result"]["hallplan"];

/** How a zone's tickets are taken, in the words the model passes on. */
export const zoneSeats = {
  byCount: "none: bought by count, no seat to pick",
  onMap: "picked on the hall map",
} as const;

export const zoneSchema = z.object({
  left: z.number().nullable(),
  prices: z.array(
    z.object({ price: z.number(), withFee: z.number().nullable() })
  ),
  // The next price the site announces, when the zone has one price.
  rise: z.object({ from: z.string(), price: z.number() }).nullable(),
  seats: z.enum([zoneSeats.byCount, zoneSeats.onMap]),
  // The ticket's own name, when it says more than the zone's.
  ticket: z.string().optional(),
  zone: z.string(),
});

type Zone = z.output<typeof zoneSchema>;

/** Cyrillic letters that look Latin: «VIР lоungе» is the zone «VIP Lounge». */
const lookalikes = new Map(
  Object.entries({
    а: "a",
    в: "b",
    е: "e",
    ё: "e",
    к: "k",
    м: "m",
    н: "h",
    о: "o",
    р: "p",
    с: "c",
    т: "t",
    у: "y",
    х: "x",
  })
);

function plain(name: string) {
  return Array.from(name.toLowerCase(), (letter) =>
    /\p{L}|\p{N}/u.test(letter) ? (lookalikes.get(letter) ?? letter) : ""
  ).join("");
}

const rubles = (kopecks: number) => kopecks / 100;

/**
 * The zones of a plan, cheapest first: each with its prices and the price
 * with the widget's fee, how many are left (`null` where the widget hides
 * it, as it does for zones without seats), and the next price the site
 * announces for a zone with one price.
 */
export function hallZones(plan: Plan, now: Date): Zone[] {
  const categories = new Map(
    plan.categories.map((category) => [category.id, category])
  );
  const hidden = plan.settings?.hideAdmissionAvailableSeatsCount === true;
  return plan.levels
    .flatMap((level): Zone[] => {
      const own = (level.categories ?? []).flatMap(({ id }) => {
        const category = categories.get(id);
        return category === undefined ? [] : [category];
      });
      const infos = own.flatMap((category) => category.priceInfos ?? []);
      const values = [
        ...new Set((level.prices ?? []).map(({ value }) => value)),
      ].sort((a, b) => a - b);
      if (level.name == null || values.length === 0) return [];
      const shown =
        values.length > pricesShown
          ? [...values.slice(0, pricesShown - 1), values[values.length - 1]]
          : values;
      const prices = shown.flatMap((value) => {
        if (value === undefined) return [];
        const total = infos.find((info) => info.price.value === value)?.total;
        return [
          {
            price: rubles(value),
            withFee: total == null ? null : rubles(total.value),
          },
        ];
      });
      const admission = level.admission === true;
      const count = level.availableSeatCount ?? null;
      const named =
        level.categories?.length === 1 ? level.categories[0] : undefined;
      const ticket =
        named?.name != null && plain(named.name) !== plain(level.name)
          ? named.name
          : undefined;
      return [
        {
          left: admission && hidden && count !== 0 ? null : count,
          prices,
          rise: values.length === 1 ? riseOf(own, values[0], now) : null,
          seats: admission ? zoneSeats.byCount : zoneSeats.onMap,
          ...(ticket === undefined ? {} : { ticket }),
          zone: level.name,
        },
      ];
    })
    .sort((a, b) => (a.prices[0]?.price ?? 0) - (b.prices[0]?.price ?? 0));
}

/** The first announced change of a one-price zone to another price. */
function riseOf(
  own: readonly Plan["categories"][number][],
  value: number | undefined,
  now: Date
) {
  const next = own
    .flatMap((category) => category.priceChanges ?? [])
    .flatMap((change) => {
      const starts = Date.parse(change.startDate);
      return Number.isNaN(starts) ||
        starts <= now.getTime() ||
        change.priceInfo.price.value === value
        ? []
        : [{ change, starts }];
    })
    .sort((a, b) => a.starts - b.starts)[0];
  return next === undefined
    ? null
    : {
        from: next.change.startDate.slice(0, 10),
        price: rubles(next.change.priceInfo.price.value),
      };
}

/** A refusal of the widget: it is left alone for a while. */
class Refused extends Error {}

async function widgetFetch(path: string, init: RequestInit = {}) {
  const send = () =>
    fetch(`${widgetOrigin}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "user-agent": userAgent,
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(requestBudgetMs),
    });
  // A connection dropped on the way is asked once more; a slow answer is not.
  const response = await send().catch(async (error: Error) => {
    if (error.name === "TimeoutError") throw error;
    return send();
  });
  if (
    response.status === 403 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    throw new Refused(`widget ${response.status}`);
  }
  return response;
}

/**
 * The anonymous cookies the widget hands any visitor, as a Cookie header:
 * the plan takes `yandexuid` only with its signed twin `i`, and a browser
 * sends them all.
 */
async function visitorCookie() {
  const response = await widgetFetch("/robots.txt", {
    headers: { accept: "text/plain" },
  });
  await response.body?.cancel();
  const pairs = response.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0] ?? "")
    .filter((pair) => /^[\w.-]+=[^\s;]*$/u.test(pair));
  if (!pairs.some((pair) => pair.startsWith("yandexuid="))) {
    throw new Refused("no visitor cookie");
  }
  return pairs.join("; ");
}

const checkSchema = z.object({
  captchaRequired: z.boolean(),
  jwt: z.string().optional(),
});
const planStateSchema = z.object({
  status: z.string(),
  url: z.string().optional(),
});

const pause = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** One session's plan: its zones, `captcha` behind a check, or nothing. */
async function sessionPlan(key: string, cookie: string, now: Date) {
  const check = checkSchema.safeParse(
    await (
      await widgetFetch("/api/antibot/check", {
        body: JSON.stringify({ sessionKey: key }),
        headers: { "content-type": "application/json", cookie },
        method: "POST",
      })
    ).json()
  );
  if (!check.success) return undefined;
  if (check.data.captchaRequired || check.data.jwt === undefined) {
    return "captcha" as const;
  }
  const until = Date.now() + planBudgetMs;
  for (;;) {
    const response = await widgetFetch(
      `/api/tickets/v4/sessions/${key}/hallplan`,
      { headers: { cookie, "x-antibot-token": check.data.jwt } }
    );
    const state = planStateSchema.safeParse(
      response.status === 200 ? await response.json() : undefined
    );
    if (!state.success) return undefined;
    if (state.data.status === "completed" && state.data.url !== undefined) {
      return planAt(state.data.url, now);
    }
    if (state.data.status !== "running" || Date.now() + pollMs > until) {
      return undefined;
    }
    await pause(pollMs);
  }
}

/** The prepared plan on the widget's CDN, read only from Yandex's own host. */
async function planAt(url: string, now: Date) {
  const address = URL.parse(url);
  if (
    address === null ||
    address.protocol !== "https:" ||
    !isYandexHost(address.hostname)
  ) {
    return undefined;
  }
  const response = await fetch(address, {
    headers: { "user-agent": userAgent },
    redirect: "error",
    signal: AbortSignal.timeout(requestBudgetMs),
  });
  if (response.status !== 200) return undefined;
  const plan = planSchema.safeParse(await response.json());
  return plan.success
    ? {
        maxTickets: plan.data.result.hallplan.maxTicketsCount ?? null,
        zones: hallZones(plan.data.result.hallplan, now),
      }
    : undefined;
}

/**
 * The zones of these sessions, by key, from the server with no browser and
 * no sign-in. A session the widget would not show (a check it puts up, an
 * answer of another shape) is left out; a refusal of the widget leaves them
 * all out and the widget alone for ten minutes.
 */
export async function sessionZones(keys: readonly string[], now: Date) {
  const zones = new Map<
    string,
    { readonly maxTickets: number | null; readonly zones: Zone[] }
  >();
  const asked = keys.filter((key) => sessionKeyPattern.test(key));
  if (asked.length === 0 || Date.now() < coolOffUntil) return zones;
  const failures: Error[] = [];
  try {
    const cookie = await visitorCookie();
    const plans = await Promise.allSettled(
      asked.map(async (key) => {
        const plan = await sessionPlan(key, cookie, now);
        if (plan !== undefined && plan !== "captcha") zones.set(key, plan);
        return plan;
      })
    );
    for (const plan of plans) {
      if (plan.status === "rejected") {
        failures.push(
          plan.reason instanceof Error ? plan.reason : new Error("rejected")
        );
      } else if (plan.value === undefined) {
        failures.push(new Error("unreadable answer"));
      } else if (plan.value === "captcha") {
        failures.push(new Error("captcha"));
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error("failed"));
  }
  if (failures.some((failure) => failure instanceof Refused)) {
    coolOffUntil = Date.now() + coolOffMs;
  }
  if (failures.length > 0) {
    console.warn("[yandex] afisha hall plan not read", {
      asked: asked.length,
      read: zones.size,
      reasons: failures.map((failure) => failure.message.slice(0, 80)),
    });
  }
  return zones;
}
