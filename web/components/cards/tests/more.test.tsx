import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as linkedom from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardAnswerScope } from "@web/components/cards/answer";
import { BlockView } from "@web/components/cards/blocks";
import { CardView } from "@web/components/cards/card-view";
import { TelegramScope } from "@web/components/cards/telegram";
import { cardSchema } from "@shared/cards/schema";

/** react-dom looks for input events when it loads, as in a browser. */
await vi.hoisted(async () => {
  const { parseHTML } = await import("linkedom");
  const { document, window } = parseHTML(
    "<!doctype html><html><body></body></html>"
  );
  Object.assign(document, { oninput: null });
  Object.assign(globalThis, { document, window });
});

/** Telegram's script, as it is once loaded: it says it is ready at once. */
vi.mock("next/script", async () => {
  const { useEffect } = await import("react");
  return {
    default: function Script({ onReady }: { readonly onReady?: () => void }) {
      useEffect(() => {
        onReady?.();
      }, [onReady]);
      return null;
    },
  };
});

const kept = (number: number) =>
  `/api/cards/${"A".repeat(43)}/photos/${String(number)}`;

const photo = (number: number, alt: string) => ({ alt, url: kept(number) });

/** A page with modal dialogs and focus, as the card's layers need. */
function openBrowser() {
  const { document, window } = linkedom.parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const focused = new Set<Element>();
  function focus(this: Element) {
    focused.clear();
    focused.add(this);
  }
  function close(this: Element) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  }
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => [...focused][0] ?? null,
  });
  Object.assign(linkedom.HTMLElement.prototype, {
    close,
    focus,
    scrollTo: () => undefined,
    showModal(this: Element) {
      this.setAttribute("open", "");
    },
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const [name, value] of Object.entries({
    Element: linkedom.Element,
    HTMLElement: linkedom.HTMLElement,
    HTMLInputElement: linkedom.HTMLInputElement,
    Node: linkedom.Node,
    ShadowRoot: linkedom.ShadowRoot,
  })) {
    vi.stubGlobal(name, value);
  }
  Object.assign(window, {
    matchMedia: () => ({ matches: false }),
    Telegram: undefined,
  });
  return { close, document, window };
}

type Browser = ReturnType<typeof openBrowser>;
const roots: ReturnType<typeof createRoot>[] = [];

async function mount(browser: Browser, page: ReactNode) {
  const container = browser.document.getElementById("root");
  if (!container) throw new Error("The page has no root.");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(page);
  });
  return container;
}

async function fire(
  browser: Browser,
  node: Element | null | undefined,
  type: string
) {
  if (!node) throw new Error(`Nothing to ${type}.`);
  await act(async () => {
    node.dispatchEvent(
      new browser.window.Event(type, { bubbles: true, cancelable: true })
    );
  });
}

const buttonOf = (root: Element, label: string) =>
  [...root.querySelectorAll("button")].find(
    (button) =>
      button.getAttribute("aria-label") === label ||
      button.textContent === label
  ) ?? null;

/** Whether each radio is picked: React sets `checked` as a property. */
const picked = (root: Element) =>
  [...root.querySelectorAll('input[type="radio"]')].map(
    (input) => input instanceof HTMLInputElement && input.checked
  );

const hotels = cardSchema.parse({
  actions: [
    { label: "Выбрать и забронировать", primary: true, submit: "book" },
    { label: "Показать другие", submit: "more_options" },
  ],
  blocks: [
    {
      id: "hotel",
      label: "Какой отель берём",
      layout: "carousel",
      options: [
        {
          detail: "Невский, 74 · 4,8",
          more: {
            facts: [
              { label: "Заезд", value: "с 14:00" },
              { label: "Отмена", value: "бесплатно до 30.10" },
            ],
            href: "https://ostrovok.ru/hotel/nordkapp/",
            photos: [photo(3, "Номер NordKapp"), photo(4, "Завтрак NordKapp")],
            text: "Тихий двор, до Невского три минуты пешком.",
          },
          photo: photo(0, "Фасад NordKapp"),
          side: "5 900 ₽",
          title: "NordKapp",
          value: "nordkapp",
        },
        {
          photo: photo(1, "Фасад Апельсина"),
          side: "6 400 ₽",
          title: "Апельсин",
          value: "apelsin",
        },
        {
          photo: photo(2, "Фасад Восстания"),
          side: "6 950 ₽",
          title: "Восстания",
          value: "vosstaniya",
        },
      ],
      type: "choice",
    },
  ],
  title: "Отели у Невского",
});

function telegram() {
  return {
    BackButton: {
      show: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onClick: vi.fn<(callback: () => void) => void>(),
      offClick: vi.fn<(callback: () => void) => void>(),
    },
    HapticFeedback: {
      notificationOccurred: vi.fn<(type: string) => void>(),
      selectionChanged: vi.fn<() => void>(),
    },
    close: vi.fn<() => void>(),
    disableVerticalSwipes: vi.fn<() => void>(),
    enableVerticalSwipes: vi.fn<() => void>(),
    expand: vi.fn<() => void>(),
    initData: "signed-launch-data",
    isVersionAtLeast: () => true,
    openLink: vi.fn<(url: string) => void>(),
    ready: vi.fn<() => void>(),
    setBackgroundColor: vi.fn<(color: string) => void>(),
    setHeaderColor: vi.fn<(color: string) => void>(),
  };
}

async function hotelsPage(browser: Browser) {
  const app = telegram();
  Object.assign(browser.window, { Telegram: { WebApp: app } });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    removeItem: () => undefined,
    setItem: () => undefined,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<() => Promise<Response>>(async () =>
      Response.json({ status: "open" })
    )
  );
  const container = await mount(
    browser,
    <TelegramScope>
      <CardAnswerScope card={hotels} link={"A".repeat(43)} revision={1}>
        <CardView card={hotels} />
      </CardAnswerScope>
    </TelegramScope>
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { app, container };
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.unstubAllGlobals();
});

describe("«Подробнее» of an option", () => {
  it("routes Telegram Back to the top layer, then chooses on the same draft without sending", async () => {
    const browser = openBrowser();
    const { app, container } = await hotelsPage(browser);
    await fire(
      browser,
      container.querySelectorAll('input[type="radio"]')[1],
      "click"
    );
    await fire(browser, buttonOf(container, "Подробнее: NordKapp"), "click");
    const back = app.BackButton.onClick.mock.calls[0]?.[0];
    if (!back) throw new Error("No native back handler.");
    await fire(
      browser,
      container.querySelector("dialog[open] ul button"),
      "click"
    );
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(2);
    act(() => {
      back();
    });
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(app.BackButton.hide).not.toHaveBeenCalled();
    await fire(browser, buttonOf(container, "Выбрать"), "click");
    expect(picked(container)).toEqual([true, false, false]);
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(0);
    expect(app.BackButton.show).toHaveBeenCalledOnce();
    expect(app.BackButton.hide).toHaveBeenCalledOnce();
    expect(app.BackButton.offClick).toHaveBeenCalledWith(back);
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });
  it("is offered only where the option has more, outside its label", async () => {
    const browser = openBrowser();
    const { container } = await hotelsPage(browser);

    const more = container.querySelectorAll(
      'fieldset button[aria-haspopup="dialog"]'
    );
    expect(more).toHaveLength(1);
    expect(more[0]?.getAttribute("aria-label")).toBe("Подробнее: NordKapp");
    expect(more[0]?.textContent).toBe("Подробнее");
    expect(more[0]?.closest("label")).toBeNull();
    expect(container.querySelectorAll("fieldset label")).toHaveLength(3);
  });

  it("opens a panel named by the option, with its photos, facts, text and site, and keeps the pick", async () => {
    const browser = openBrowser();
    const { container } = await hotelsPage(browser);
    await fire(
      browser,
      container.querySelectorAll('input[type="radio"]')[1],
      "click"
    );
    expect(picked(container)).toEqual([false, true, false]);

    const opener = buttonOf(container, "Подробнее: NordKapp");
    await fire(browser, opener, "click");

    const panel = container.querySelector("dialog[open]");
    expect(panel).not.toBeNull();
    const heading = panel?.querySelector("h2");
    expect(heading?.textContent).toBe("NordKapp");
    expect(panel?.getAttribute("aria-labelledby")).toBe(heading?.id);
    expect(browser.document.activeElement).toBe(heading);
    expect(panel?.textContent).toContain("5 900 ₽");
    expect(panel?.textContent).toContain("Невский, 74 · 4,8");
    expect(
      [...(panel?.querySelectorAll("ul img") ?? [])].map((image) =>
        image.getAttribute("alt")
      )
    ).toEqual(["Фасад NordKapp", "Номер NordKapp", "Завтрак NordKapp"]);
    expect(panel?.querySelector("[aria-live]")?.textContent).toContain(
      "1 из 3"
    );
    expect(
      [...(panel?.querySelectorAll("dt") ?? [])].map((term) => term.textContent)
    ).toEqual(["Заезд", "Отмена"]);
    expect(panel?.textContent).toContain("Тихий двор");
    const site = [...(panel?.querySelectorAll("a") ?? [])].find(
      (anchor) => anchor.textContent === "Открыть на сайте"
    );
    expect(site?.getAttribute("href")).toBe(
      "https://ostrovok.ru/hotel/nordkapp/"
    );
    expect(picked(container)).toEqual([false, true, false]);

    const cross = [...(panel?.querySelectorAll("button") ?? [])].find(
      (button) =>
        button.getAttribute("aria-label") === "Закрыть" &&
        button.getAttribute("tabindex") !== "-1"
    );
    await fire(browser, cross, "click");
    expect(container.querySelector("dialog[open]")).toBeNull();
    expect(browser.document.activeElement).toBe(opener);
    expect(picked(container)).toEqual([false, true, false]);
  });

  it("closes on Escape and on a tap on the card above it", async () => {
    const browser = openBrowser();
    const { container } = await hotelsPage(browser);
    const opener = buttonOf(container, "Подробнее: NordKapp");

    await fire(browser, opener, "click");
    browser.close.call(
      container.querySelector("dialog[open]") ?? browser.document.body
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("dialog[open]")).toBeNull();

    await fire(browser, opener, "click");
    const above = container.querySelector("dialog[open] button[tabindex='-1']");
    expect(above?.getAttribute("aria-label")).toBe("Закрыть");
    await fire(browser, above, "click");
    expect(container.querySelector("dialog[open]")).toBeNull();
  });

  it("opens a photo of the panel on the full screen over it, and holds Telegram's pull-to-close until the panel closes", async () => {
    const browser = openBrowser();
    const { app, container } = await hotelsPage(browser);

    await fire(browser, buttonOf(container, "Подробнее: NordKapp"), "click");
    expect(app.disableVerticalSwipes).toHaveBeenCalledOnce();
    const photos = container.querySelectorAll("dialog[open] ul button");
    await fire(browser, photos[1], "click");
    const open = container.querySelectorAll("dialog[open]");
    expect(open).toHaveLength(2);
    expect(open[1]?.getAttribute("aria-label")).toBe("Фото 2 из 3");

    const viewerCross = [...(open[1]?.querySelectorAll("button") ?? [])].find(
      (button) => button.getAttribute("aria-label") === "Закрыть"
    );
    await fire(browser, viewerCross, "click");
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(app.enableVerticalSwipes).not.toHaveBeenCalled();

    browser.close.call(
      container.querySelector("dialog[open]") ?? browser.document.body
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(app.enableVerticalSwipes).toHaveBeenCalledOnce();
  });

  it("keeps the panel open when the photo viewer emits its native close event", async () => {
    const browser = openBrowser();
    const { app, container } = await hotelsPage(browser);
    await fire(browser, buttonOf(container, "Подробнее: NordKapp"), "click");
    await fire(
      browser,
      container.querySelector("dialog[open] ul button"),
      "click"
    );
    const viewer = container.querySelectorAll("dialog[open]")[1];
    await fire(browser, viewer, "close");
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(
      container.querySelector("dialog[open]")?.getAttribute("aria-labelledby")
    ).not.toBeNull();
    expect(app.enableVerticalSwipes).not.toHaveBeenCalled();
  });
});

describe("«Подробнее» of a list row", () => {
  it("makes the row no link and gives the panel the row's link", async () => {
    const browser = openBrowser();
    const container = await mount(
      browser,
      <BlockView
        block={{
          layout: "rows",
          rows: [
            {
              href: "https://example.com/flat",
              more: { text: "Окна во двор, пятый этаж без лифта." },
              side: "4 200 ₽",
              title: "Квартира на Рубинштейна",
            },
            { href: "https://example.com/other", title: "Другая квартира" },
          ],
          type: "list",
        }}
      />
    );

    const rows = container.querySelectorAll("li");
    expect(rows[0]?.querySelector("a")).toBeNull();
    expect(rows[1]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/other"
    );
    await fire(
      browser,
      buttonOf(container, "Подробнее: Квартира на Рубинштейна"),
      "click"
    );
    const site = [...container.querySelectorAll("dialog[open] a")].find(
      (anchor) => anchor.textContent === "Открыть на сайте"
    );
    expect(site?.getAttribute("href")).toBe("https://example.com/flat");
    expect(container.querySelector("dialog[open]")?.textContent).toContain(
      "пятый этаж"
    );
    expect(container.querySelector("dialog[open] ul")).toBeNull();
  });
});
