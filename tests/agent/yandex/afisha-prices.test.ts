import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { afishaPricesDirect } from "@agent/lib/yandex/afisha/direct";
import { zoneSeats } from "@agent/lib/yandex/afisha/hall";
import { afishaPricesOperation } from "@agent/lib/yandex/afisha/prices";
import { dataOf, fixture, runInPage } from "./page";

const args = afishaPricesOperation.args.parse({
  event: "69fcccedecb85d003180b725",
});
const planUrl = "https://cdn1.svc.cdn.yandex.net/hallplans/abc";

/** What the widget answers, step by step, as `fetch` sees it. */
interface Widget {
  readonly check?: () => Response;
  readonly plan?: () => Response;
}

/**
 * Afisha and the ticket widget behind one `fetch`: the schedule, the
 * visitor's cookies, the antibot check, a plan that is prepared on the
 * second ask, and the plan on the CDN.
 */
async function services(widget: Widget = {}) {
  const sessions = await fixture("afisha/sessions.json");
  const plan = await fixture("afisha/hallplan.json");
  let asked = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(z.string().or(z.instanceof(URL)).parse(input));
    if (url.hostname === "afisha.yandex.ru") return Response.json(sessions);
    if (url.pathname === "/robots.txt") {
      const headers = new Headers();
      headers.append("set-cookie", "yandexuid=123; Path=/; Secure");
      headers.append("set-cookie", "i=signed; Path=/; HttpOnly");
      return new Response("User-agent: *", { headers });
    }
    if (url.pathname === "/api/antibot/check") {
      return (
        widget.check?.() ??
        Response.json({ captchaRequired: false, jwt: "token" })
      );
    }
    if (url.pathname.endsWith("/hallplan")) {
      asked += 1;
      return (
        widget.plan?.() ??
        Response.json(
          asked === 1
            ? { status: "running" }
            : { status: "completed", url: planUrl }
        )
      );
    }
    if (url.href === planUrl) return Response.json(plan);
    return new Response("not found", { status: 404 });
  });
}

/** The direct answer, with the widget's polls run out on the fake clock. */
async function pricesDirect(input = args) {
  const answer = afishaPricesDirect(input);
  await vi.runAllTimersAsync();
  return answer;
}

/** The URLs of the widget a spy was asked. */
const widgetCalls = (spy: ReturnType<typeof vi.fn<typeof fetch>>) =>
  spy.mock.calls.filter(([input]) =>
    String(input).startsWith("https://widget.afisha.yandex.ru/")
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T10:00:00+03:00"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("afisha.prices", () => {
  it("names every zone of a session and which ones have no seat to pick", async () => {
    const spy = await services();
    vi.stubGlobal("fetch", spy);
    const answer = z
      .object({
        sessions: z.array(
          z.object({
            maxTickets: z.number().nullable(),
            zones: z.array(z.json()).nullable(),
          })
        ),
      })
      .parse(await pricesDirect());
    const [first, closed] = answer.sessions;
    expect(first?.maxTickets).toBe(6);
    expect(first?.zones).toEqual([
      {
        // Nine prices: the cheapest seven and the dearest.
        left: 0,
        prices: [1200, 1500, 2000, 2500, 3000, 3500, 4000, 6000].map(
          (price) => ({ price, withFee: Math.round(price * 1.1) })
        ),
        rise: null,
        seats: zoneSeats.onMap,
        zone: "Партер",
      },
      {
        left: null,
        prices: [{ price: 2300, withFee: 2530 }],
        rise: { from: "2026-11-01", price: 2400 },
        seats: zoneSeats.byCount,
        zone: "Танцпол",
      },
      {
        left: null,
        prices: [{ price: 4200, withFee: 4620 }],
        rise: { from: "2026-11-01", price: 4500 },
        seats: zoneSeats.byCount,
        ticket: "ВИП-входной (без места)",
        zone: "VIP-входной (свободная рассадка)",
      },
      {
        // «VIР lоungе» with Cyrillic letters is the zone's own name.
        left: 51,
        prices: [{ price: 5500, withFee: 6050 }],
        rise: null,
        seats: zoneSeats.onMap,
        zone: "VIP Lounge",
      },
    ]);
    // A session that is not on sale has no plan to read.
    expect(closed?.zones).toBeNull();
    // The plan takes the visitor's cookie only with its signed twin.
    const planCall = widgetCalls(spy).find(([input]) =>
      String(input).endsWith("/hallplan")
    );
    expect(new Headers(planCall?.[1]?.headers).get("cookie")).toBe(
      "yandexuid=123; i=signed"
    );
  });

  it("lists the same sessions as the page does, the zones unread behind the widget's check", async () => {
    const spy = await services({
      check: () => Response.json({ captchaRequired: true }),
    });
    vi.stubGlobal("fetch", spy);
    const direct = await pricesDirect();
    const sessions = await fixture("afisha/sessions.json");
    const pageAsked: (string | null | undefined)[] = [];
    const fromPage = await runInPage(afishaPricesOperation.run, args, {
      origin: "https://afisha.yandex.ru/robots.txt",
      respond: (_, init) => {
        pageAsked.push(init.body);
        return { body: sessions };
      },
    });
    expect(direct).toEqual(dataOf(fromPage));
    expect(direct).toMatchObject({
      more: 0,
      sessions: [{ zones: null }, { zones: null }],
    });
    const asked = z
      .object({ variables: z.json() })
      .parse(JSON.parse(z.string().parse(pageAsked[0])));
    expect(asked.variables).toEqual({
      dates: { date: "2026-10-22", period: 180 },
      id: args.event,
    });
  });

  it("leaves the widget alone for ten minutes after it refused, and still lists the sessions", async () => {
    vi.setSystemTime(new Date("2026-10-23T10:00:00+03:00"));
    const spy = await services({
      plan: () => new Response("busy", { status: 429 }),
    });
    vi.stubGlobal("fetch", spy);
    expect(await pricesDirect()).toMatchObject({
      sessions: [{ zones: null }, { zones: null }],
    });
    const refusedAfter = widgetCalls(spy).length;
    await pricesDirect();
    expect(widgetCalls(spy)).toHaveLength(refusedAfter);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    vi.stubGlobal("fetch", await services());
    expect(await pricesDirect()).toMatchObject({
      sessions: [{ maxTickets: 6 }, { zones: null }],
    });
  });

  it("answers a day that is none without asking Afisha, as the page does", async () => {
    const spy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", spy);
    const badDay = afishaPricesOperation.args.parse({
      date: "2026-02-30",
      event: args.event,
    });
    const page = await runInPage(afishaPricesOperation.run, badDay, {
      origin: "https://afisha.yandex.ru/robots.txt",
      respond: () => ({ body: null }),
    });
    expect(await pricesDirect(badDay)).toEqual({ error: "bad_date" });
    expect(dataOf(page)).toEqual({ error: "bad_date" });
    expect(spy).not.toHaveBeenCalled();
  });
});
