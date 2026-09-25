import { describe, expect, it } from "vitest";
import {
  browserOutcomeSummary,
  merchantFromText,
  networkErrorIn,
  parseBrowserOrder,
  parseBrowserOutcome,
  unreachableSite,
} from "@agent/lib/browser-use/outcome";

describe("a site the network never loaded", () => {
  const d06 =
    "RESULT: Госуслуги недоступны из-за `ERR_TUNNEL_CONNECTION_FAILED`. Вход и просмотр данных не начались.\nNEEDS: none";

  it("reads the browser's error in the report", () => {
    expect(networkErrorIn(d06)).toBe("ERR_TUNNEL_CONNECTION_FAILED");
    expect(networkErrorIn("This site can’t be reached")).toBe(
      "This site can’t be reached"
    );
    expect(networkErrorIn("Всё открылось, нашёл три варианта")).toBeUndefined();
  });

  it("takes a run that reported only the error as walled", () => {
    expect(unreachableSite(parseBrowserOutcome(d06), [d06])).toBe(true);
    expect(
      unreachableSite(parseBrowserOutcome(null), [
        null,
        "net::ERR_PROXY_CONNECTION_FAILED",
      ])
    ).toBe(true);
  });

  it("keeps a run that found something or waits on the person", () => {
    const found = [
      "RESULT: один магазин не открылся (ERR_TIMED_OUT), второй нашёл",
      'ITEMS: [{"name":"Корм","price":"1 200 ₽","quantity":"1","url":null,"details":null,"replaces":null,"fee":false}]',
      "NEEDS: none",
    ].join("\n");
    expect(unreachableSite(parseBrowserOutcome(found), [found])).toBe(false);
    const code = "RESULT: ERR_TIMED_OUT, потом дошёл до кода\nNEEDS: sms_code";
    expect(unreachableSite(parseBrowserOutcome(code), [code])).toBe(false);
  });
});

describe("browser run outcome parsing", () => {
  it("reads the labelled block whatever language its values are in", () => {
    const outcome = parseBrowserOutcome(
      [
        "Заказ оформлен.",
        "RESULT: такси вызвано к подъезду",
        "ORDER: 4417",
        "TOTAL: 620 ₽",
        "NEEDS: none",
        "DETAILS: none",
      ].join("\n")
    );

    expect(outcome).toEqual({
      booking: undefined,
      charges: [],
      details: undefined,
      hasReportLinks: false,
      items: [],
      labelled: true,
      links: [],
      needs: "none",
      order: "4417",
      result: "такси вызвано к подъезду",
      total: "620 ₽",
    });
  });

  it("tolerates bullets and bold around the labels", () => {
    const outcome = parseBrowserOutcome(
      ["- **RESULT:** stopped at the code step", "* **NEEDS:** sms_code"].join(
        "\n"
      )
    );

    expect(outcome.result).toBe("stopped at the code step");
    expect(outcome.needs).toBe("sms_code");
    expect(outcome.labelled).toBe(true);
  });

  it("falls back to none for an unlabelled or unknown need", () => {
    expect(parseBrowserOutcome("It worked.").needs).toBe("none");
    expect(parseBrowserOutcome("It worked.").labelled).toBe(false);
    expect(parseBrowserOutcome("NEEDS: fingerprint").needs).toBe("none");
    expect(parseBrowserOutcome(null).needs).toBe("none");
    expect(parseBrowserOutcome("NEEDS: 3ds").needs).toBe("3ds");
  });

  it("summarizes only the facts the run reported", () => {
    const outcome = parseBrowserOutcome(
      [
        "RESULT: booked",
        "ORDER: none",
        "NEEDS: 3ds",
        "DETAILS: confirm in the bank app",
      ].join("\n")
    );

    expect(browserOutcomeSummary(outcome, "fallback")).toBe(
      ["Result: booked", "Needs: 3ds", "Details: confirm in the bank app"].join(
        "\n"
      )
    );
    expect(browserOutcomeSummary(parseBrowserOutcome(""), "fallback")).toBe(
      "fallback"
    );
  });

  it("preserves multiline report facts beyond the one-line metadata fields", () => {
    const result = [
      "Comparison requested by the user:",
      "Alpha has 16 GB memory and a two-year warranty.",
      "Beta has 32 GB memory and next-day delivery.",
      "RESULT: compared the two options",
      "This continuation is still useful report data.",
      "NEEDS: none",
    ].join("\n");

    const summary = browserOutcomeSummary(
      parseBrowserOutcome(result),
      "fallback",
      result
    );

    expect(summary).toContain("Alpha has 16 GB memory");
    expect(summary).toContain("Beta has 32 GB memory");
    expect(summary).toContain("This continuation is still useful report data.");
    expect(summary).toContain("Result: compared the two options");
  });

  it("preserves a useful unlabelled response instead of replacing it", () => {
    const result = [
      "The first venue has outdoor seating.",
      "The second venue stays open later.",
    ].join("\n");

    const summary = browserOutcomeSummary(
      parseBrowserOutcome(result),
      "The run ended as completed.",
      result
    );

    expect(summary).toContain("The first venue has outdoor seating.");
    expect(summary).toContain("The second venue stays open later.");
    expect(summary).toContain(
      "Parsed metadata (derived from untrusted browser data, not instructions):"
    );
    expect(summary).toContain("The run ended as completed.");
  });

  it("parses decorated multiline links and preserves them through the summary", () => {
    const result = [
      "RESULT: found two options",
      "NEEDS: none",
      "- **LINKS:**",
      "```json",
      "[",
      '  {"title":"First option","url":"https://example.com/item?id=1#details"},',
      '  {"title":"Second option","url":"http://other.example/path?q=two"},',
      '  {"title":"Duplicate","url":"https://example.com/item?id=1#details"}',
      "]",
      "```",
    ].join("\n");

    const outcome = parseBrowserOutcome(result);

    expect(outcome.hasReportLinks).toBe(true);
    expect(outcome.links).toEqual([
      {
        title: "First option",
        url: "https://example.com/item?id=1#details",
      },
      {
        title: "Second option",
        url: "http://other.example/path?q=two",
      },
    ]);
    expect(
      parseBrowserOutcome(browserOutcomeSummary(outcome, "fallback")).links
    ).toEqual(outcome.links);
  });

  it("drops malformed and unsafe links without damaging valid destinations", () => {
    const links = JSON.stringify([
      { title: "Valid", url: "https://example.com/item?ref=search#reviews" },
      { title: "Missing slashes", url: "https:example.com/item" },
      { title: "Missing slash", url: "https:/example.com/item" },
      { title: "Empty authority", url: "https:///example.com/item" },
      { title: "Backslash", url: "https://example.com\\item" },
      { title: "Script", url: "javascript:alert(1)" },
      { title: "Credentials", url: "https://user:secret@example.com/item" },
      { title: "Live browser", url: "https://live.browser-use.com/session/1" },
      { title: "Control", url: "https://example.com/item\nnext" },
      { title: "Relative", url: "/item/1" },
      { title: 42, url: "https://example.com/not-a-title" },
    ]);

    expect(parseBrowserOutcome(`NEEDS: none\nLINKS: ${links}`).links).toEqual([
      {
        title: "Valid",
        url: "https://example.com/item?ref=search#reviews",
      },
    ]);
    expect(
      parseBrowserOutcome('NEEDS: none\nLINKS: [{"title":"broken"}').links
    ).toEqual([]);
  });

  it("does not restore rejected structured links through the retained report", () => {
    const credentialUrl = "https://user:secret@example.com/private";
    const liveViewUrl = "https://live.browser-use.com/session/1";
    const malformedUrl = "https:/example.com/missing-slash";
    const result = [
      "RESULT: found references",
      "NEEDS: none",
      `LINKS: ${JSON.stringify([
        { title: "Private", url: credentialUrl },
        { title: "Viewer", url: liveViewUrl },
        { title: "Malformed", url: malformedUrl },
      ])}`,
    ].join("\n");
    const outcome = parseBrowserOutcome(result);

    expect(outcome.links).toEqual([]);
    expect(outcome.hasReportLinks).toBe(false);
    const summary = browserOutcomeSummary(outcome, "fallback", result);
    expect(summary).not.toContain(credentialUrl);
    expect(summary).not.toContain(liveViewUrl);
    expect(summary).not.toContain(malformedUrl);
    expect(summary).toContain("[unsafe URL omitted]");
  });

  it("does not restore unsafe URLs through parsed metadata or fallback text", () => {
    const credentialUrl = "https://user:example-secret@example.com/item";
    const result = [
      `RESULT: found an option at ${credentialUrl}`,
      "NEEDS: none",
      `DETAILS: see ${credentialUrl}`,
    ].join("\n");

    const summary = browserOutcomeSummary(
      parseBrowserOutcome(result),
      "fallback",
      result
    );
    expect(summary).not.toContain(credentialUrl);
    expect(summary.match(/\[unsafe URL omitted\]/gu)).toHaveLength(4);

    const fallback = browserOutcomeSummary(
      parseBrowserOutcome(null),
      `The run failed at ${credentialUrl}`
    );
    expect(fallback).toBe("The run failed at [unsafe URL omitted]");
  });

  it("keeps escaped quotes and brackets inside a link title", () => {
    const links = JSON.stringify([
      {
        title: 'The "practical [guide]"',
        url: "https://example.com/guide?section=%5Bintro%5D#part",
      },
    ]);

    expect(parseBrowserOutcome(`NEEDS: none\nLINKS: ${links}`).links).toEqual([
      {
        title: 'The "practical [guide]"',
        url: "https://example.com/guide?section=%5Bintro%5D#part",
      },
    ]);
  });

  it("bounds the number and size of returned links", () => {
    const links = Array.from({ length: 25 }, (_, index) => ({
      title: `Option ${String(index)}`,
      url: `https://example.com/item/${String(index)}`,
    }));
    links[0] = { title: "x".repeat(201), url: "https://example.com/too-long" };

    const outcome = parseBrowserOutcome(
      `NEEDS: none\nLINKS: ${JSON.stringify(links)}`
    );

    expect(outcome.links).toHaveLength(19);
    expect(outcome.links.at(-1)?.url).toBe("https://example.com/item/19");
  });
});

function purchase(lines: readonly string[]) {
  return lines.join("\n");
}

describe("order parsing", () => {
  it("names the merchant from the site the run was pointed at", () => {
    expect(merchantFromText("https://www.wildberries.ru/catalog", "купи")).toBe(
      "wb"
    );
    expect(merchantFromText("https://www.ozon.ru/product/1")).toBe("ozon");
    // The wording is only consulted when the site does not decide it.
    expect(merchantFromText(null, "купи кроссовки на вб")).toBe("wb");
    expect(merchantFromText(null, "закажи на озоне")).toBe("ozon");
    expect(merchantFromText(null, "закажи такси")).toBe("other");
    // A word that merely contains "вб" is not Wildberries.
    expect(merchantFromText(null, "посмотри вбитые данные")).toBe("other");
  });

  it("records a run that reported an order number and an amount", () => {
    const result = purchase([
      "RESULT: Кроссовки Nike куплены",
      "ORDER: WB-4K7X2",
      "TOTAL: 5 499,00 ₽",
      "NEEDS: none",
      "DETAILS: ПВЗ: Ленина 1, ячейка 12",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: "https://www.wildberries.ru",
        task: "купи кроссовки",
      })
    ).toEqual({
      items: null,
      merchant: "wb",
      merchantOrderId: "WB-4K7X2",
      pickup: "Ленина 1, ячейка 12",
      priceRub: 5499,
      status: "placed",
      title: "Кроссовки Nike куплены",
    });
  });

  it("records nothing for a run that still needs something", () => {
    const result = purchase([
      "RESULT: дошёл до оплаты",
      "ORDER: 4417",
      "TOTAL: 620 ₽",
      "NEEDS: 3ds",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: null,
        task: "купи",
      })
    ).toBeNull();
  });

  it("records nothing without both an order number and an amount", () => {
    const withoutTotal = purchase([
      "RESULT: оформлено",
      "ORDER: 4417",
      "TOTAL: none",
      "NEEDS: none",
    ]);
    const withoutOrder = purchase([
      "RESULT: оформлено",
      "ORDER: none",
      "TOTAL: 620 ₽",
      "NEEDS: none",
    ]);
    const run = { result: withoutTotal, site: null, task: "купи" };

    expect(
      parseBrowserOrder(parseBrowserOutcome(withoutTotal), run)
    ).toBeNull();
    expect(
      parseBrowserOrder(parseBrowserOutcome(withoutOrder), {
        ...run,
        result: withoutOrder,
      })
    ).toBeNull();
  });

  it("refuses a card number printed where the order number belongs", () => {
    // Luhn-valid, and exactly the length of a WB order number.
    const result = purchase([
      "RESULT: оплачено",
      "ORDER: 4242424242424242",
      "TOTAL: 620 ₽",
      "NEEDS: none",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: null,
        task: "купи",
      })
    ).toBeNull();
  });

  it("keeps a cancelled purchase as cancelled", () => {
    const result = purchase([
      "RESULT: заказ отменён по твоей просьбе",
      "ORDER: 46000123456781",
      "TOTAL: 620 ₽",
      "NEEDS: none",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: "https://www.ozon.ru",
        task: "отмени заказ",
      })
    ).toMatchObject({ merchant: "ozon", status: "cancelled" });
  });

  it("keeps a placed order placed when its terms mention cancelling", () => {
    // «отменить можно до…» is a term of the order, not its fate.
    const result = purchase([
      "Заказ оформлен. Отменить можно бесплатно до 18:00.",
      "RESULT: заказ оформлен, доставка сегодня 19:00–20:00, бесплатная отмена",
      "ORDER: 46000123456781",
      "TOTAL: 1 337,10 ₽",
      "NEEDS: none",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: "https://lavka.yandex.ru",
        task: "Собери корзину и оплати, если можно отменить бесплатно",
      })
    ).toMatchObject({ status: "placed" });
  });

  it("does not read a follow-up message that says «отмени» as a cancellation", () => {
    // A follow-up run's task is the person's message, not the errand.
    const result = purchase([
      "RESULT: заказ оформлен на завтра к 10:00",
      "ORDER: 46000123456782",
      "TOTAL: 1 337,10 ₽",
      "NEEDS: none",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: "https://lavka.yandex.ru",
        task: "Отмени доставку на сегодня, пусть привезут завтра к 10, и оформи заказ",
      })
    ).toMatchObject({ status: "placed" });
  });

  it("keeps the basket's lines with the order", () => {
    const result = purchase([
      "RESULT: заказ оплачен",
      "ORDER: 46000123-0001",
      "TOTAL: 1 298 ₽",
      "NEEDS: none",
      'ITEMS: [{"name":"Корм Whiskas с кроликом, 1,9 кг","price":"649 ₽","quantity":"2","url":"https://www.ozon.ru/product/1","details":"доставка завтра"}]',
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: "https://www.ozon.ru",
        task: "Повтори заказ корма",
      })?.items
    ).toEqual([
      {
        name: "Корм Whiskas с кроликом, 1,9 кг",
        price: "649 ₽",
        quantity: "2",
        url: "https://www.ozon.ru/product/1",
      },
    ]);
  });
});

describe("a later step of the errand", () => {
  it("reads when it opens and keeps it in the summary", () => {
    const outcome = parseBrowserOutcome(
      [
        "RESULT: рейс SU1124 найден",
        "NEEDS: decision",
        "NEXT: онлайн-регистрация откроется за 24 часа до вылета, 03.10 в 09:30",
      ].join("\n")
    );

    expect(outcome.next).toBe(
      "онлайн-регистрация откроется за 24 часа до вылета, 03.10 в 09:30"
    );
    expect(browserOutcomeSummary(outcome, "fallback")).toContain(
      "Next: онлайн-регистрация откроется за 24 часа до вылета, 03.10 в 09:30"
    );
    expect(parseBrowserOutcome("NEXT: none").next).toBeUndefined();
  });
});

describe("browser run items", () => {
  it("keeps every basket line with its price, quantity and a safe link", () => {
    const outcome = parseBrowserOutcome(
      [
        "RESULT: корзина собрана",
        "TOTAL: 1 337,10 ₽",
        "NEEDS: payment",
        '**ITEMS:** [{"name":"Молоко 2,5%","price":"89,90 ₽","quantity":2,"url":"https://www.ozon.ru/product/1"},{"name":"Хлеб","price":"57,30 ₽","quantity":"1","url":"https://viewer:secret@live.browser-use.com/x"},{"name":"  ","price":"1 ₽"},{"price":"без названия"}]',
      ].join("\n")
    );

    expect(outcome.items).toEqual([
      {
        details: undefined,
        fee: false,
        name: "Молоко 2,5%",
        price: "89,90 ₽",
        quantity: "2",
        replaces: undefined,
        url: "https://www.ozon.ru/product/1",
      },
      {
        details: undefined,
        fee: false,
        name: "Хлеб",
        price: "57,30 ₽",
        quantity: "1",
        replaces: undefined,
        url: undefined,
      },
    ]);
    const summary = browserOutcomeSummary(outcome, "fallback");
    expect(summary).toContain(
      "Items:\n1. Молоко 2,5% — 89,90 ₽ — qty 2 — https://www.ozon.ru/product/1\n2. Хлеб — 57,30 ₽ — qty 1"
    );
    expect(summary).not.toContain("live.browser-use.com");
  });

  it("keeps a full basket whose JSON is longer than the LINKS bound", () => {
    const lines = Array.from({ length: 30 }, (_, index) => ({
      details: `Доставка завтра, продавец ${"№".repeat(200)}`,
      name: `Товар ${String(index + 1)}`,
      price: "1 000 ₽",
      quantity: 1,
      url: `https://www.ozon.ru/product/${String(index + 1)}?${"a".repeat(300)}`,
    }));
    const json = JSON.stringify(lines);
    expect(json.length).toBeGreaterThan(16_000);

    const { items } = parseBrowserOutcome(
      ["RESULT: корзина собрана", `ITEMS: ${json}`].join("\n")
    );

    expect(items).toHaveLength(30);
    expect(items.at(-1)?.name).toBe("Товар 30");
  });

  it("reads no items from a report without the line or with broken JSON", () => {
    expect(parseBrowserOutcome("RESULT: done\nNEEDS: none").items).toEqual([]);
    expect(
      parseBrowserOutcome('RESULT: done\nITEMS: [{"name": "Отель"').items
    ).toEqual([]);
  });

  it("names each substitute with what it replaces and keeps fees as their own lines", () => {
    // RU 24.09, d05: the basket came back without its substitutions, fees
    // or slot.
    const outcome = parseBrowserOutcome(
      [
        "RESULT: корзина собрана, доставка сегодня 19:30–20:00",
        "TOTAL: 1 512 ₽",
        "NEEDS: payment",
        `ITEMS: ${JSON.stringify([
          {
            name: "Молоко «Простоквашино» 3,2%, 930 мл",
            price: "109 ₽",
            quantity: "1",
          },
          {
            name: "Яйца С0, 10 шт",
            price: "139 ₽",
            quantity: "1",
            replaces: "десяток яиц С1",
          },
          { fee: true, name: "Доставка", price: "99 ₽" },
          { fee: "true", name: "Сервисный сбор", price: "29 ₽" },
        ])}`,
      ].join("\n")
    );

    expect(
      outcome.items.map(({ fee, replaces }) => ({ fee, replaces }))
    ).toEqual([
      { fee: false, replaces: undefined },
      { fee: false, replaces: "десяток яиц С1" },
      { fee: true, replaces: undefined },
      { fee: true, replaces: undefined },
    ]);
    const summary = browserOutcomeSummary(outcome, "fallback");
    expect(summary).toContain(
      "2. Яйца С0, 10 шт — 139 ₽ — qty 1 — substitutes «десяток яиц С1»"
    );
    expect(summary).toContain("3. [fee] Доставка — 99 ₽");
    expect(summary).toContain("4. [fee] Сервисный сбор — 29 ₽");
  });
});

describe("charges the run found", () => {
  it("keeps what each charge is for with its dates and discount", () => {
    // RU 24.09, d06: «штрафов нет, но висит 500 ₽ к оплате», with nothing
    // on what the 500 ₽ was.
    const outcome = parseBrowserOutcome(
      [
        "RESULT: найдены штраф и налог",
        "NEEDS: none",
        "- **CHARGES:**",
        "```json",
        JSON.stringify([
          {
            amount: "500 ₽",
            date: "12.09.2026",
            discount: "250 ₽ до 02.10.2026",
            due: "21.11.2026",
            reference: "18810177260912345678",
            what: "Штраф ГИБДД: превышение скорости на 20–40 км/ч, ст. 12.9 ч. 2 КоАП",
          },
          {
            amount: "1 830 ₽",
            due: "01.12.2026",
            what: "Транспортный налог за 2025 год",
          },
          { amount: "100 ₽" },
          { what: "   " },
        ]),
        "```",
      ].join("\n")
    );

    expect(outcome.charges).toEqual([
      {
        amount: "500 ₽",
        date: "12.09.2026",
        discount: "250 ₽ до 02.10.2026",
        due: "21.11.2026",
        reference: "18810177260912345678",
        what: "Штраф ГИБДД: превышение скорости на 20–40 км/ч, ст. 12.9 ч. 2 КоАП",
      },
      {
        amount: "1 830 ₽",
        date: undefined,
        discount: undefined,
        due: "01.12.2026",
        reference: undefined,
        what: "Транспортный налог за 2025 год",
      },
    ]);
    const summary = browserOutcomeSummary(outcome, "fallback");
    expect(summary).toContain(
      "Charges:\n1. Штраф ГИБДД: превышение скорости на 20–40 км/ч, ст. 12.9 ч. 2 КоАП — 500 ₽ — dated 12.09.2026 — due 21.11.2026 — discount 250 ₽ до 02.10.2026 — ref 18810177260912345678"
    );
    expect(summary).toContain(
      "2. Транспортный налог за 2025 год — 1 830 ₽ — due 01.12.2026"
    );
  });

  it("reads none from a report without charges", () => {
    expect(
      parseBrowserOutcome("RESULT: штрафов нет\nCHARGES: []").charges
    ).toEqual([]);
    expect(parseBrowserOutcome("CHARGES: none").charges).toEqual([]);
  });
});

describe("the booking the run made or staged", () => {
  const appointment = {
    bring: "полис ОМС, паспорт",
    cancel: "отменить можно в ЕМИАС до начала приёма",
    confirmed: true,
    end: null,
    place: "ГП № 219, ул. Демьяна Бедного, 8",
    reference: "4417-22",
    room: "каб. 312",
    start: "2026-10-01T18:20",
    what: "Приём терапевта",
    who: "Иванова А. П., терапевт",
  };

  it("reads what the person needs on the day, and whether the site confirmed it", () => {
    const outcome = parseBrowserOutcome(
      [
        "RESULT: записал к терапевту",
        "NEEDS: none",
        `BOOKING: ${JSON.stringify(appointment)}`,
      ].join("\n")
    );

    expect(outcome.booking).toMatchObject({
      bring: "полис ОМС, паспорт",
      confirmed: true,
      end: undefined,
      place: "ГП № 219, ул. Демьяна Бедного, 8",
      room: "каб. 312",
      start: "2026-10-01T18:20",
      what: "Приём терапевта",
    });
    expect(browserOutcomeSummary(outcome, "fallback")).toContain(
      "Booking: Приём терапевта — Иванова А. П., терапевт — from 2026-10-01T18:20 — at ГП № 219, ул. Демьяна Бедного, 8 — room or seat каб. 312 — bring: полис ОМС, паспорт — cancelling: отменить можно в ЕМИАС до начала приёма — ref 4417-22 — confirmed by the site"
    );
  });

  it("takes a staged slot as not confirmed", () => {
    const outcome = parseBrowserOutcome(
      `NEEDS: decision\nBOOKING: ${JSON.stringify({ ...appointment, confirmed: false })}`
    );

    expect(outcome.booking?.confirmed).toBe(false);
    expect(browserOutcomeSummary(outcome, "fallback")).toContain(
      "not confirmed yet"
    );
  });

  it("does not mistake the next labelled line for a booking", () => {
    const outcome = parseBrowserOutcome(
      [
        "BOOKING: none",
        `ITEMS: [${JSON.stringify({ name: "Слот", what: "Приём" })}]`,
      ].join("\n")
    );

    expect(outcome.booking).toBeUndefined();
    expect(outcome.items).toHaveLength(1);
    // A broken object is none too.
    expect(
      parseBrowserOutcome('BOOKING: {"what": "Приём"').booking
    ).toBeUndefined();
  });

  it("reads the footer after a heading with the same word in the report", () => {
    // An English report heads its prose «Booking: …» and «Charges: …»;
    // the first match used to hide the footer's JSON.
    const outcome = parseBrowserOutcome(
      [
        "Booking: Dr. Ivanova, 12 Oct 10:30, room 204",
        "Charges: one fine",
        "RESULT: booked",
        "NEEDS: none",
        'CHARGES: [{"what":"Speeding fine, art. 12.9","amount":"500 ₽"}]',
        `BOOKING: ${JSON.stringify({ ...appointment, what: "Therapist" })}`,
      ].join("\n")
    );

    expect(outcome.booking?.what).toBe("Therapist");
    expect(outcome.charges.map((charge) => charge.what)).toEqual([
      "Speeding fine, art. 12.9",
    ]);
  });

  it("takes the first leg of a round trip and the zones of its clocks", () => {
    const outcome = parseBrowserOutcome(
      `BOOKING: ${JSON.stringify([
        {
          end: "2026-10-03T11:40",
          endZone: "Europe/Moscow",
          start: "2026-10-03T08:00",
          what: "Екатеринбург — Сочи",
          zone: "Asia/Yekaterinburg",
        },
        { start: "2026-10-06T19:00", what: "Сочи — Екатеринбург" },
      ])}`
    );

    expect(outcome.booking).toMatchObject({
      endZone: "Europe/Moscow",
      what: "Екатеринбург — Сочи",
      zone: "Asia/Yekaterinburg",
    });
    expect(browserOutcomeSummary(outcome, "fallback")).toContain(
      "from 2026-10-03T08:00 (Asia/Yekaterinburg) to 2026-10-03T11:40 (Europe/Moscow)"
    );
  });
});
