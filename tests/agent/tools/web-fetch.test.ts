import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import type { ToolContext } from "eve/tools";
import { WEB_FETCH_OUTPUT_SCHEMA } from "eve/tools/web_fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** eve's own fetch reaches the network through the global `fetch`. */
const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();
const routes = new Map<string, () => Response>();
/** What eve answers for a URL that would reach the machine or its network. */
const privateAddressRefusal =
  "URL must not target localhost, private, link-local, or reserved IP addresses.";

function pageAt(url: string, html: string, status = 200) {
  routes.set(
    url,
    () =>
      new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
        status,
      })
  );
}

function page(title: string, body: string) {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

const venueCard = page(
  "Авокадо, ресторан, Чистопрудный бул., 12 — Яндекс Карты",
  `<h1>Авокадо</h1><p>${"Вегетарианская кухня, средний чек 1200 ₽, открыто до 23:00. ".repeat(10)}</p>`
);

function toolContext(
  abortSignal = new AbortController().signal,
  sessionId = "session-1"
) {
  return {
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    abortSignal,
    callId: "call-1",
    getToken: vi.fn<ToolContext["getToken"]>(),
    requireAuth: vi.fn<ToolContext["requireAuth"]>(),
    session: {
      auth: { current: null, initiator: null },
      id: sessionId,
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "web_fetch",
  } satisfies ToolContext;
}

async function fetchPage(url: string, ctx = toolContext()) {
  const { webFetchTool } = await import("@agent/tools/web_fetch");
  return WEB_FETCH_OUTPUT_SCHEMA.parse(
    await webFetchTool.execute({ url }, ctx)
  );
}

function timeoutError() {
  return new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError"
  );
}

beforeEach(() => {
  vi.resetModules();
  routes.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) => {
    const route = routes.get(String(url));
    return route ? route() : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("web_fetch", () => {
  it("returns a readable page as Markdown", async () => {
    const url = "https://yandex.ru/maps/org/avokado/1099046369/";
    pageAt(url, venueCard);

    const result = await fetchPage(url);

    expect(result.url).toBe(url);
    expect(result.content).toContain("средний чек 1200 ₽");
    expect(result.content).not.toContain("web_fetch could not read");
  });

  it("gives the page twelve seconds unless the model asks for more", async () => {
    const url = "https://slow.example/page";
    pageAt(url, venueCard);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { webFetchTool } = await import("@agent/tools/web_fetch");

    await webFetchTool.execute({ url }, toolContext());
    await webFetchTool.execute({ timeout: 90, url }, toolContext());

    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([12_000, 30_000]);
    timeout.mockRestore();
  });

  it("names a captcha on Yandex Maps and points at the map's search excerpts", async () => {
    const url = "https://yandex.ru/maps/org/tsiniki/107802168711/";
    pageAt(
      url,
      page(
        "Вы не робот?",
        "<p>Подтвердите, что запросы отправляли вы, а не робот</p>"
      )
    );

    const result = await fetchPage(url);

    expect(result.contentType).toBe("text/plain");
    expect(result.content).toContain(
      "the page is a captcha or bot check, not the content"
    );
    expect(result.content).toContain(
      'call web_search with sites: ["yandex.ru/maps"]'
    );
    expect(result.content).toContain("restoclub.ru");
    // Wording alone does not close the site.
    expect(result.content).not.toContain("Do not fetch it");
    await fetchPage(url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads a short page that mentions reCAPTCHA or a block in its heading", async () => {
    const booking = "https://receptor.example/booking";
    const news = "https://news.example/court";
    pageAt(
      booking,
      page(
        "Бронь столика",
        "<h1>Форма защищена reCAPTCHA</h1><form>Имя, телефон, время</form>"
      )
    );
    pageAt(
      news,
      page(
        "Новости",
        "<h1>Доступ запрещён: суд оставил в силе блокировку сайта</h1><p>Подробности.</p>"
      )
    );

    expect((await fetchPage(booking)).content).toContain("Имя, телефон");
    expect((await fetchPage(news)).content).toContain("суд оставил в силе");
  });

  it("does not ask a refusing site again for a while", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    pageAt("https://www.2gis.ru/moscow/firm/1", "Forbidden", 403);
    pageAt("https://2gis.ru/moscow/firm/2", venueCard);

    const refused = await fetchPage("https://www.2gis.ru/moscow/firm/1");
    expect(refused.content).toContain(
      "the site refused automated reading (HTTP 403)"
    );
    expect(refused.content).toContain('sites: ["2gis.ru"]');

    const skipped = await fetchPage("https://2gis.ru/moscow/firm/2");
    expect(skipped.content).toContain("so it was not asked again");
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(11 * 60_000);
    const later = await fetchPage("https://2gis.ru/moscow/firm/2");
    expect(later.content).toContain("средний чек 1200 ₽");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("turns a page that did not answer in time into a note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchMock.mockRejectedValueOnce(timeoutError());

    const hung = await fetchPage("https://slow.example/a");
    expect(hung.content).toContain("the site did not answer within 12 seconds");
    expect(hung.content).toContain("web_search excerpts or another site");

    const skipped = await fetchPage("https://slow.example/b");
    expect(skipped.content).toContain("so it was not asked again");
    expect(fetchMock).toHaveBeenCalledOnce();

    // A slow site is given up on for less time than one that refused.
    vi.advanceTimersByTime(4 * 60_000);
    await fetchPage("https://slow.example/b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names a map page that came back as an empty shell without remembering it", async () => {
    const url = "https://2gis.ru/moscow/firm/3";
    pageAt(url, page("2ГИС", "<div>. . . . . .</div>"));

    const first = await fetchPage(url);
    expect(first.content).toContain("2GIS sent only its JavaScript shell");

    await fetchPage(url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a refusal to the conversation that met it", async () => {
    pageAt("https://2gis.ru/moscow/firm/1", "Forbidden", 403);
    pageAt("https://2gis.ru/moscow/firm/2", venueCard);

    await fetchPage("https://2gis.ru/moscow/firm/1");
    const other = await fetchPage(
      "https://2gis.ru/moscow/firm/2",
      toolContext(undefined, "session-2")
    );

    expect(other.content).toContain("средний чек 1200 ₽");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a page that needs a login and does not close the site", async () => {
    pageAt("https://shop.example/orders", "Please sign in", 401);
    pageAt("https://shop.example/catalog", venueCard);

    const orders = await fetchPage("https://shop.example/orders");
    expect(orders.content).toMatch(/^Request failed with status code: 401/u);

    const catalog = await fetchPage("https://shop.example/catalog");
    expect(catalog.content).toContain("средний чек 1200 ₽");
  });

  it("does not blame a link shortener for the site behind it", async () => {
    pageAt("https://clck.ru/abc", "Forbidden", 403);
    pageAt("https://clck.ru/def", venueCard);

    const refused = await fetchPage("https://clck.ru/abc");
    expect(refused.content).toContain("HTTP 403");

    const next = await fetchPage("https://clck.ru/def");
    expect(next.content).toContain("средний чек 1200 ₽");
  });

  it("forgets the oldest refusal once it remembers five hundred", async () => {
    fetchMock.mockImplementation(
      async () => new Response("Forbidden", { status: 403 })
    );

    for (let index = 0; index <= 500; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Refusals are remembered in order.
      await fetchPage(`https://blocked-${String(index)}.example/`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(501);

    await fetchPage("https://blocked-500.example/other");
    expect(fetchMock).toHaveBeenCalledTimes(501);
    await fetchPage("https://blocked-0.example/other");
    expect(fetchMock).toHaveBeenCalledTimes(502);
  });

  it("does not mistake an article that mentions a captcha for a check page", async () => {
    const url = "https://news.example/captcha";
    pageAt(
      url,
      page(
        "Новости",
        `<p>${"Длинная статья о жизни города. ".repeat(800)}</p><p>captcha</p>`
      )
    );

    const result = await fetchPage(url);

    expect(result.content).toContain("Длинная статья");
  });

  it("lets an aborted turn fail as it is", async () => {
    const turn = new AbortController();
    turn.abort();
    fetchMock.mockRejectedValueOnce(timeoutError());

    await expect(
      fetchPage("https://slow.example/a", toolContext(turn.signal))
    ).rejects.toThrow("timeout");
  });

  // eve refuses these itself (`requestPublicUrl`, which checks every hop and
  // every resolved address); Bro's wrapper relies on it, so an eve update
  // that drops the check must fail here. eve and the world's queue listen on
  // loopback, and the cloud's metadata service sits at 169.254.169.254.
  it.each([
    "https://127.0.0.1/",
    "https://127.0.0.1:4274/.well-known/workflow/v1/flow",
    "https://localhost/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/",
    "https://0x7f000001/",
  ])("never asks %s", async (url) => {
    await expect(fetchPage(url)).rejects.toThrow(privateAddressRefusal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never follows a redirect to a private address", async () => {
    const url = "https://short.example/go";
    routes.set(
      url,
      () =>
        new Response(null, {
          headers: { location: "https://169.254.169.254/latest/meta-data/" },
          status: 302,
        })
    );

    await expect(fetchPage(url)).rejects.toThrow(privateAddressRefusal);
    expect(fetchMock.mock.calls.map(([asked]) => String(asked))).toEqual([url]);
  });

  it("never connects to a name that resolves to a private address", async () => {
    vi.unstubAllGlobals();
    // eve is loaded by Node itself, past vitest's mocks: the name is
    // answered by swapping the builtin's own export for every importer.
    const asked: string[] = [];
    // SAFETY: eve asks with `all: true`, the overload this answers.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- One overload of an overloaded builtin is implemented.
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(((
      hostname: string,
      _options: LookupOptions,
      callback: (error: null, addresses: LookupAddress[]) => void
    ) => {
      asked.push(hostname);
      callback(null, [{ address: "169.254.169.254", family: 4 }]);
    }) as typeof dns.lookup);
    syncBuiltinESMExports();
    try {
      // undici reports the refused lookup as the cause of «fetch failed».
      await expect(fetchPage("https://rebind.example/")).rejects.toHaveProperty(
        "cause.message",
        privateAddressRefusal
      );
      expect(asked).toEqual(["rebind.example"]);
    } finally {
      lookup.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
