import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type * as z from "zod";
import { describe, expect, it } from "vitest";
import { cardSchema } from "@shared/cards/schema";
import { CardView } from "@web/components/cards/card-view";
import flightBooked from "../../../../docs/cards/examples/flight-booked.json";
import restaurantsCompare from "../../../../docs/cards/examples/restaurants-compare.json";
import weekendItinerary from "../../../../docs/cards/examples/weekend-itinerary.json";

type CardInput = z.input<typeof cardSchema>;

function pageOf(input: CardInput) {
  const card = cardSchema.parse(input);
  return parseHTML(renderToStaticMarkup(createElement(CardView, { card })))
    .document;
}

function blocksOf(...blocks: CardInput["blocks"]) {
  return pageOf({ blocks, title: "Карточка" });
}

const texts = (document: ReturnType<typeof pageOf>, selector: string) =>
  [...document.querySelectorAll(selector)].map((node) => node.textContent);

const plate = (document: ReturnType<typeof pageOf>) =>
  document.querySelector("article")?.textContent;

describe("card view", () => {
  it("sets the flight card: a route, facts, a figure, a code, a note and one button", () => {
    const document = pageOf(cardSchema.parse(flightBooked));

    expect(document.querySelectorAll("article")).toHaveLength(1);
    expect(document.querySelector("article")?.getAttribute("data-tone")).toBe(
      "success"
    );
    expect(texts(document, "h1")).toEqual(["Москва → Казань"]);
    expect(document.querySelector("header")?.textContent).toContain(
      "Билеты · оформлено"
    );
    expect(plate(document)).toContain("Откуда: 08:40SVOШереметьево");
    expect(plate(document)).toContain("Куда: 10:15KZNКазань");
    expect(plate(document)).toContain("Победа · DP 421");
    expect(texts(document, "dl dt")).toEqual(
      expect.arrayContaining(["Пассажир", "Багаж", "Оплачено", "Итого"])
    );
    expect(texts(document, "dl strong")).toEqual(["Карта •• 4417"]);
    expect(plate(document)).toContain("7 450 ₽");
    expect(texts(document, "button")).toEqual(["Копировать"]);
    expect(texts(document, '[role="note"]')).toEqual([
      "Регистрация откроется за 24 часа до вылета. Напомню в пятницу утром.",
    ]);
    expect(texts(document, "article a")).toEqual(["Открыть бронь"]);
    expect(plate(document)).toContain("Изменить или вернуть билет");
  });

  it("sets the comparison card: chips, a table with a chosen row, a list with links", () => {
    const document = pageOf(cardSchema.parse(restaurantsCompare));

    expect(document.querySelector("article")?.getAttribute("data-tone")).toBe(
      "neutral"
    );
    expect(texts(document, "ul > li > span")).toEqual([
      "Рядом",
      "Тихо",
      "Без очереди",
    ]);
    expect(texts(document, 'th[scope="col"]')).toEqual([
      "Место",
      "Чек",
      "Рейтинг",
      "Идти",
    ]);
    expect(texts(document, 'th[scope="row"]')).toEqual([
      "Выбрано: Ветер",
      "Усадьба",
      "Лавка 12",
    ]);
    expect(document.querySelectorAll("hr")).toHaveLength(1);
    expect(document.querySelectorAll("li a")).toHaveLength(2);
    expect(document.querySelectorAll("li")).toHaveLength(6);
    expect(texts(document, '[role="note"] p')).toEqual([
      "Столик держат недолго",
      "В «Усадьбе» бронь снимают через 15 минут после назначенного времени.",
    ]);
    expect(
      [...document.querySelectorAll("article > div > div:last-child a")].map(
        (link) => link.getAttribute("href")
      )
    ).toEqual(["https://example.com/places/veter/book", "tel:+74951234567"]);
  });

  it("sets the itinerary card: a figure, headings, one current step and a read-only list", () => {
    const document = pageOf(cardSchema.parse(weekendItinerary));

    expect(document.querySelector("article")?.getAttribute("data-tone")).toBe(
      "info"
    );
    expect(document.querySelectorAll("figure img")).toHaveLength(1);
    expect(texts(document, "figcaption")).toEqual(["Кремль, вид с набережной"]);
    expect(texts(document, "h2")).toEqual(["Маршрут", "Не забыть"]);
    expect(document.querySelectorAll("ol > li")).toHaveLength(4);
    expect(
      [...document.querySelectorAll('li[aria-current="step"]')].map(
        (step) => step.textContent
      )
    ).toEqual(["Сб 12:00Сейчас: Обед в «Тюбетее»Столик на двоих заказан"]);
    expect(
      [...document.querySelectorAll('input[type="checkbox"]')].map((box) => [
        box.hasAttribute("disabled"),
        box.hasAttribute("checked"),
      ])
    ).toEqual([
      [true, true],
      [true, false],
      [true, false],
    ]);
    expect(plate(document)).toContain("38 200 ₽");
  });
});

describe("blocks", () => {
  it("sets a heading as an h2 under the card's h1", () => {
    const document = blocksOf({ text: "Маршрут", type: "heading" });
    expect(texts(document, "h2")).toEqual(["Маршрут"]);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("keeps the line breaks of a text through CSS, not through markup", () => {
    const document = blocksOf(
      { text: "Первая строка.\nВторая строка.", type: "text" },
      { muted: true, text: "Мелко", type: "text" }
    );
    const [plain, muted] = [...document.querySelectorAll("article p")].slice(
      -2
    );
    expect(plain?.textContent).toBe("Первая строка.\nВторая строка.");
    expect(plain?.className).toContain("whitespace-pre-line");
    expect(plain?.className).toContain("wrap-anywhere");
    expect(document.querySelectorAll("br")).toHaveLength(0);
    expect(muted?.className).toContain("text-muted-foreground");
  });

  it("sets facts as a description list and bolds only the strong value", () => {
    const document = blocksOf({
      rows: [
        { label: "Пассажир", value: "Савелий" },
        { label: "Оплачено", strong: true, value: "Карта •• 4417" },
      ],
      type: "facts",
    });
    expect(document.querySelectorAll("dl > div")).toHaveLength(2);
    expect(texts(document, "dt")).toEqual(["Пассажир", "Оплачено"]);
    expect(texts(document, "dd")).toEqual(["Савелий", "Карта •• 4417"]);
    expect(texts(document, "dd strong")).toEqual(["Карта •• 4417"]);
  });

  it("sets a stat as a label, a value and an optional hint", () => {
    const document = blocksOf(
      { label: "Итого", type: "stat", value: "7 450 ₽" },
      { hint: "сбор 450 ₽", label: "Остаток", type: "stat", value: "1 200 ₽" }
    );
    const [bare, hinted] = document.querySelectorAll("dl");
    expect(bare?.querySelectorAll("dt, dd")).toHaveLength(2);
    expect(hinted?.querySelectorAll("dd")).toHaveLength(2);
    expect(hinted?.textContent).toBe("Остаток1 200 ₽сбор 450 ₽");
  });

  it("makes the whole row of a list a link when it has an address", () => {
    const document = blocksOf({
      rows: [
        {
          chip: { color: "yellow", text: "Мой выбор" },
          href: "https://example.com/a",
          side: "2 800 ₽",
          subtitle: "Кухня",
          title: "Ветер",
        },
        { side: "1 900 ₽", title: "Лавка" },
      ],
      type: "list",
    });
    const [linked, plain] = document.querySelectorAll("ul > li");
    expect(linked?.querySelector("a")?.textContent).toBe(
      "ВетерКухняМой выбор2 800 ₽"
    );
    expect(linked?.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/a"
    );
    expect(plain?.querySelector("a")).toBeNull();
    expect(plain?.textContent).toBe("Лавка1 900 ₽");
  });

  it("marks the one current step of a timeline for assistive technology", () => {
    const document = blocksOf({
      steps: [
        { state: "done", title: "Заявка", time: "Пн" },
        { state: "current", title: "Оплата" },
        { title: "Доставка" },
      ],
      type: "timeline",
    });
    const steps = [...document.querySelectorAll("ol > li")];
    expect(steps.map((step) => step.getAttribute("aria-current"))).toEqual([
      null,
      "step",
      null,
    ]);
    expect(steps.map((step) => step.textContent)).toEqual([
      "ПнВыполнено: Заявка",
      "Сейчас: Оплата",
      "Дальше: Доставка",
    ]);
  });

  it("sets a route as two stops and reads without a time or a code", () => {
    const document = blocksOf({
      from: {
        code: "MSK",
        note: "Платформа 3",
        place: "Курский",
        time: "22:15",
      },
      meta: "Поезд 054Г",
      to: { place: "Нижний Новгород" },
      type: "route",
    });
    expect(plate(document)).toContain("Откуда: 22:15MSKКурскийПлатформа 3");
    expect(plate(document)).toContain("Куда: Нижний Новгород");
    expect(plate(document)).toContain("Поезд 054Г");
  });

  it("sets a table with headed columns and rows, marks the chosen row and scrolls inside the plate", () => {
    const document = blocksOf({
      columns: ["Тариф", "Цена"],
      highlight: 1,
      rows: [
        ["Эконом", "1 900 ₽"],
        ["Стандарт", "3 500 ₽"],
      ],
      type: "table",
    });
    expect(document.querySelector("table")?.parentElement?.className).toContain(
      "overflow-x-auto"
    );
    expect(texts(document, 'thead th[scope="col"]')).toEqual(["Тариф", "Цена"]);
    const rows = [...document.querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual([
      "Эконом",
      "Выбрано: Стандарт",
    ]);
    expect(rows[0]?.querySelector("th")?.className).toContain("sticky");
    expect(rows[1]?.querySelector("td")?.className).toContain("bg-bro-yellow");
    expect(rows[0]?.querySelector("td")?.className).not.toContain(
      "bg-bro-yellow"
    );
  });

  it("sets a callout as a note with its tone", () => {
    const document = blocksOf({
      text: "Платёж отклонён.\nПопробуем завтра.",
      title: "Деньги не списаны",
      tone: "danger",
      type: "callout",
    });
    const note = document.querySelector('[role="note"]');
    expect(note?.className).toContain("bg-bro-coral");
    expect(note?.className).toContain("text-bro-error");
    expect(texts(document, '[role="note"] p')).toEqual([
      "Деньги не списаны",
      "Платёж отклонён.\nПопробуем завтра.",
    ]);
    expect(
      document.querySelector('[role="note"] p:last-child')?.className
    ).toContain("whitespace-pre-line");
  });

  it("sets chips as a list and tints each by its colour", () => {
    const document = blocksOf({
      items: [{ text: "Рядом", color: "blue" }, { text: "Тихо" }],
      type: "chips",
    });
    const chips = [...document.querySelectorAll("ul > li > span")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["Рядом", "Тихо"]);
    expect(chips[0]?.className).toContain("bg-bro-blue");
    expect(chips[1]?.className).toContain("bg-secondary");
  });

  it("sets a checklist as disabled checkboxes, checked where done", () => {
    const document = blocksOf({
      items: [{ done: true, text: "Паспорт" }, { text: "Зарядка" }],
      type: "checklist",
    });
    const boxes = [
      ...document.querySelectorAll('li label input[type="checkbox"]'),
    ];
    expect(boxes.map((box) => box.hasAttribute("checked"))).toEqual([
      true,
      false,
    ]);
    expect(boxes.every((box) => box.hasAttribute("disabled"))).toBe(true);
    expect(texts(document, "li label")).toEqual(["Паспорт", "Зарядка"]);
  });

  it("sets an image as a plain lazy img that sends no referrer", () => {
    const document = blocksOf({
      alt: "Кремль",
      caption: "Вид с набережной",
      type: "image",
      url: "https://images.example.org/kremlin.jpg",
    });
    const image = document.querySelector("figure > img");
    expect(image?.getAttribute("src")).toBe(
      "https://images.example.org/kremlin.jpg"
    );
    expect(image?.getAttribute("alt")).toBe("Кремль");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(image?.getAttribute("referrerPolicy")).toBe("no-referrer");
    expect(image?.className).toContain("aspect-4/3");
    expect(texts(document, "figure > figcaption")).toEqual([
      "Вид с набережной",
    ]);
  });

  it("sets a copyable with its label, its value and a copy button", () => {
    const document = blocksOf({
      label: "Код бронирования",
      type: "copyable",
      value: "XK4P7Q",
    });
    expect(plate(document)).toContain("Код бронирования");
    expect(plate(document)).toContain("XK4P7Q");
    expect(texts(document, "button")).toEqual(["Копировать"]);
  });

  it("sets a divider as a rule", () => {
    expect(
      blocksOf({ type: "divider" }, { type: "divider" }).querySelectorAll("hr")
    ).toHaveLength(2);
  });
});

describe("data only", () => {
  const evil = "<img src=x onerror=a()>";
  const markup = "<b>x</b>";

  const hostile = {
    actions: [
      { href: "https://example.com/a", label: evil, primary: true },
      { href: "tel:+74951234567", label: "Позвонить" },
      { href: "mailto:help@example.com", label: "Написать" },
    ],
    blocks: [
      { text: evil, type: "heading" },
      { text: `${evil}<script>alert(1)</script>`, type: "text" },
      {
        rows: [{ label: evil, strong: true, value: evil }],
        type: "facts",
      },
      { hint: evil, label: evil, type: "stat", value: markup },
      {
        rows: [
          {
            chip: { color: "pink", text: evil },
            href: "https://example.com/b",
            side: evil,
            subtitle: evil,
            title: evil,
          },
        ],
        type: "list",
      },
      {
        steps: [
          { detail: evil, state: "current", time: markup, title: evil },
          { title: markup },
        ],
        type: "timeline",
      },
      {
        from: { code: markup, note: evil, place: evil, time: markup },
        meta: evil,
        to: { place: evil },
        type: "route",
      },
      {
        columns: [evil, evil],
        highlight: 0,
        rows: [[evil, evil]],
        type: "table",
      },
      { text: evil, title: evil, tone: "warning", type: "callout" },
      { items: [{ text: evil }], type: "chips" },
      { items: [{ done: true, text: evil }], type: "checklist" },
      {
        alt: evil,
        caption: evil,
        type: "image",
        url: "https://images.example.org/a.jpg",
      },
      { label: evil, type: "copyable", value: evil },
    ],
    footnote: evil,
    kicker: evil,
    subtitle: evil,
    title: evil,
  } satisfies CardInput;

  it("shows what the model wrote as text and never as markup", () => {
    const html = renderToStaticMarkup(
      createElement(CardView, { card: cardSchema.parse(hostile) })
    );
    const { document } = parseHTML(html);

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=a()&gt;");
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.querySelectorAll("b")).toHaveLength(0);
    expect(document.querySelectorAll("img")).toHaveLength(1);
    expect(document.querySelector("img")?.getAttribute("alt")).toBe(evil);
    expect(document.querySelector("h1")?.textContent).toBe(evil);
    const handlers = [...document.querySelectorAll("*")].flatMap((node) =>
      node.getAttributeNames().filter((name) => name.startsWith("on"))
    );
    expect(handlers).toEqual([]);
  });

  it("opens every link without handing the card to the page it opens", () => {
    const links = [
      ...pageOf(cardSchema.parse(hostile)).querySelectorAll("article a"),
    ];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/b",
      "https://example.com/a",
      "tel:+74951234567",
      "mailto:help@example.com",
    ]);
    for (const link of links) {
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(links.map((link) => link.getAttribute("target"))).toEqual([
      "_blank",
      "_blank",
      null,
      null,
    ]);
  });
});
