import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import * as linkedom from "linkedom";
import type * as z from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardSchema } from "@shared/cards/schema";
import { BlockView } from "@web/components/cards/blocks";
import { CardView } from "@web/components/cards/card-view";
import { PhotoFrame } from "@web/components/cards/photo-frame";
import apartmentGallery from "../../../../docs/cards/examples/apartment-gallery.json";
import vacuumCompare from "../../../../docs/cards/examples/vacuum-compare.json";
import weekendIdeasPhotos from "../../../../docs/cards/examples/weekend-ideas-photos.json";

type Block = z.infer<typeof cardSchema>["blocks"][number];

const kept = (number: number) =>
  `/api/cards/${"A".repeat(43)}/photos/${String(number)}`;

function staticPage(card: z.infer<typeof cardSchema>) {
  return linkedom.parseHTML(
    renderToStaticMarkup(createElement(CardView, { card }))
  ).document;
}

const gallery = cardSchema.parse(apartmentGallery).blocks[0];

/** Slides lie 300 px apart, as they would on a phone. */
function slideOffset(this: Element) {
  return this.tagName === "LI" && this.parentElement
    ? [...this.parentElement.children].indexOf(this) * 300
    : 0;
}

function openBrowser({ reducedMotion = false } = {}) {
  const { document, window } = linkedom.parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const focused = new Set<Element>();
  const scrollTo = vi.fn<(options: ScrollToOptions) => void>();
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
  Object.defineProperty(linkedom.HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get: slideOffset,
  });
  Object.assign(linkedom.HTMLElement.prototype, {
    close,
    focus,
    scrollTo,
    showModal(this: Element) {
      this.setAttribute("open", "");
    },
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Element", linkedom.Element);
  vi.stubGlobal("HTMLElement", linkedom.HTMLElement);
  vi.stubGlobal("Node", linkedom.Node);
  vi.stubGlobal("ShadowRoot", linkedom.ShadowRoot);
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: reducedMotion && query.includes("reduce"),
    }),
    Telegram: undefined,
  });
  return {
    close: (node: Element | null | undefined) => {
      if (node) close.call(node);
    },
    document,
    focus: (node: Element | undefined) => {
      if (node) focus.call(node);
    },
    scrollTo,
    window,
  };
}

type Browser = ReturnType<typeof openBrowser>;

async function mount(browser: Browser, page: ReactNode) {
  const container = browser.document.getElementById("root");
  if (!container) throw new Error("The page has no root.");
  await act(async () => {
    createRoot(container).render(page);
  });
  return container;
}

async function fire(
  browser: Browser,
  node: Element | null | undefined,
  type: string,
  fields: Record<string, number | string | boolean> = {}
) {
  if (!node) throw new Error(`Nothing to ${type}.`);
  const event = Object.assign(
    new browser.window.Event(type, { bubbles: true, cancelable: true }),
    fields
  );
  await act(async () => {
    node.dispatchEvent(event);
  });
  return event;
}

async function rest(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const counter = (container: Element) =>
  container.querySelector("[aria-live]")?.textContent;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("photos on a card", () => {
  it("frames an image at 4:3 with its alt, lazily and without a referrer, and its caption and source", () => {
    const document = linkedom.parseHTML(
      renderToStaticMarkup(
        createElement(BlockView, {
          block: {
            alt: "Кремль с набережной",
            caption: "Вид из номера",
            credit: "ostrovok.ru",
            type: "image",
            url: kept(0),
          },
        })
      )
    ).document;

    const figure = document.querySelector("figure");
    const image = figure?.querySelector("span > img");
    expect(image?.getAttribute("src")).toBe(kept(0));
    expect(image?.getAttribute("alt")).toBe("Кремль с набережной");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(image?.getAttribute("referrerPolicy")).toBe("no-referrer");
    expect(image?.parentElement?.className).toContain("aspect-4/3");
    expect(image?.parentElement?.className).toContain("bg-secondary");
    expect(figure?.className).toContain("not-has-[img]:hidden");
    expect(figure?.querySelector("figcaption")?.textContent).toBe(
      "Вид из номера · Фото: ostrovok.ru"
    );
  });

  it("sets rows with photos as 72 px thumbnails beside the text", () => {
    const rows = [
      ...staticPage(cardSchema.parse(weekendIdeasPhotos)).querySelectorAll(
        "ul > li"
      ),
    ];

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const frame = row.querySelector("span.size-18");
      expect(frame?.className).toContain("rounded-sm");
      expect(frame?.querySelector("img")?.getAttribute("alt")).toBeTruthy();
      expect(frame?.nextElementSibling?.textContent).toContain(
        row.querySelector("span.font-\\[600\\]")?.textContent ?? "?"
      );
    }
  });

  it("sets a carousel of options as 280 px cards with a 4:3 photo on top, each card one link", () => {
    const document = staticPage(cardSchema.parse(vacuumCompare));
    const strip = document.querySelector(
      'section[aria-roledescription="карусель"]'
    );
    const slides = [...(strip?.querySelectorAll("ul > li") ?? [])];

    expect(slides).toHaveLength(3);
    expect(slides[0]?.className).toContain("w-70");
    const first = slides[0]?.querySelector("a");
    expect(first?.getAttribute("href")).toBe(
      "https://example.com/shop/roborock-q8"
    );
    expect(first?.firstElementChild?.className).toContain("aspect-4/3");
    expect(first?.querySelector("img")?.getAttribute("alt")).toBe(
      "Робот-пылесос Roborock Q8 сверху"
    );
    expect(first?.textContent).toContain("Roborock Q8");
    expect(first?.textContent).toContain("23\u00a0990\u00a0₽");
    expect(first?.textContent).toContain("Мой выбор");
    expect(first?.textContent).toContain("Фото: ozon.ru");
  });

  it("sets a gallery as a strip of photos that open full screen, with its count, dots and caption", () => {
    const document = staticPage(cardSchema.parse(apartmentGallery));
    const figure = document.querySelector("figure");
    const photos = [...(figure?.querySelectorAll("ul > li > button") ?? [])];

    expect(photos).toHaveLength(5);
    for (const photo of photos) {
      expect(photo.getAttribute("aria-haspopup")).toBe("dialog");
      expect(photo.querySelector("img")?.getAttribute("alt")).toBeTruthy();
    }
    expect(photos[0]?.querySelector("img")?.getAttribute("loading")).toBe(
      "eager"
    );
    expect(photos[1]?.querySelector("img")?.getAttribute("loading")).toBe(
      "lazy"
    );
    expect(figure?.textContent).toContain("1 / 5");
    expect(figure?.querySelectorAll("span.rounded-full")).toHaveLength(5);
    expect(
      figure
        ?.querySelector('button[aria-label="Листать назад"]')
        ?.hasAttribute("disabled")
    ).toBe(true);
    expect(figure?.querySelector("figcaption")?.textContent).toBe(
      "Фото с объявления на Циан · Фото: cian.ru"
    );
  });
});

describe("leafing through photos", () => {
  if (gallery?.type !== "gallery") throw new Error("The example is a gallery.");
  const block: Block = gallery;

  it("steps with its buttons and the arrow keys, and never on its own", async () => {
    const browser = openBrowser();
    const page = await mount(browser, <BlockView block={block} />);
    const strip = page.querySelector("ul");

    await fire(
      browser,
      page.querySelector('button[aria-label="Листать вперёд"]'),
      "click"
    );
    expect(counter(page)).toBe("2 из 5");
    expect(browser.scrollTo).toHaveBeenLastCalledWith({
      behavior: "smooth",
      left: 300,
    });

    await fire(browser, strip, "keydown", { key: "ArrowRight" });
    expect(counter(page)).toBe("3 из 5");
    await fire(browser, strip, "keydown", { key: "End" });
    expect(counter(page)).toBe("5 из 5");
    expect(
      page
        .querySelector('button[aria-label="Листать вперёд"]')
        ?.hasAttribute("disabled")
    ).toBe(true);
    await fire(browser, strip, "keydown", { key: "Home" });
    expect(counter(page)).toBe("1 из 5");
    expect(browser.scrollTo).toHaveBeenLastCalledWith({
      behavior: "smooth",
      left: 0,
    });

    await rest(300);
    expect(counter(page)).toBe("1 из 5");
  });

  it("jumps without animation for a person who asked for less motion", async () => {
    const browser = openBrowser({ reducedMotion: true });
    const page = await mount(browser, <BlockView block={block} />);

    await fire(browser, page.querySelector("ul"), "keydown", {
      key: "ArrowRight",
    });
    expect(browser.scrollTo).toHaveBeenLastCalledWith({
      behavior: "auto",
      left: 300,
    });
  });

  it("counts the photo a swipe settles on, and ticks the haptics where Telegram has them", async () => {
    const selectionChanged = vi.fn<() => void>();
    const browser = openBrowser();
    Object.assign(browser.window, {
      Telegram: {
        WebApp: {
          HapticFeedback: { selectionChanged },
          initData: "query_id=1",
          isVersionAtLeast: () => true,
        },
      },
    });
    const page = await mount(browser, <BlockView block={block} />);
    const strip = page.querySelector("ul");
    if (!strip) throw new Error("No strip.");

    strip.scrollLeft = 610;
    await fire(browser, strip, "scroll");
    await rest(150);
    expect(counter(page)).toBe("3 из 5");
    expect(selectionChanged).toHaveBeenCalledOnce();

    Object.assign(browser.window, { Telegram: undefined });
    strip.scrollLeft = 300;
    await fire(browser, strip, "scroll");
    await rest(150);
    expect(counter(page)).toBe("2 из 5");
    expect(selectionChanged).toHaveBeenCalledOnce();
  });

  it("takes a photo that does not load out of the strip and out of its count", async () => {
    const browser = openBrowser();
    const page = await mount(browser, <BlockView block={block} />);

    await fire(browser, page.querySelectorAll("ul img")[2], "error");

    expect(page.querySelectorAll("ul > li")).toHaveLength(4);
    expect(page.querySelectorAll("ul > li:empty")).toHaveLength(0);
    expect(counter(page)).toBe("1 из 4");
  });

  it("takes away the frame of a photo that failed before the page came to life", async () => {
    const browser = openBrowser();
    const onFailure = vi.fn<() => void>();
    Object.defineProperties(linkedom.HTMLElement.prototype, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 0 },
    });
    try {
      const page = await mount(
        browser,
        <PhotoFrame
          onFailure={onFailure}
          photo={{ alt: "Холл", url: kept(1) }}
        />
      );
      expect(page.querySelector("span")).toBeNull();
      expect(onFailure).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(linkedom.HTMLElement.prototype, "complete");
      Reflect.deleteProperty(linkedom.HTMLElement.prototype, "naturalWidth");
    }
  });
});

describe("the full-screen photo", () => {
  if (gallery?.type !== "gallery") throw new Error("The example is a gallery.");
  const block: Block = gallery;

  async function opened(browser: Browser) {
    const page = await mount(browser, <BlockView block={block} />);
    const second = page.querySelectorAll("ul > li > button")[1];
    browser.focus(second);
    await fire(browser, second, "click");
    const dialog = page.querySelector("dialog");
    return { dialog, page, second };
  }

  it("opens on the tapped photo, keeps focus on its strip and gives it back on Escape", async () => {
    const browser = openBrowser();
    const { dialog, second } = await opened(browser);

    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.getAttribute("aria-label")).toBe("Фото 2 из 5");
    expect(browser.document.activeElement).toBe(dialog?.querySelector("ul"));
    expect(browser.document.documentElement.style.overflow).toBe("hidden");
    expect(dialog?.querySelector("p")?.textContent).toBe("2 / 5");

    await fire(browser, dialog?.querySelector("ul"), "keydown", {
      key: "ArrowRight",
    });
    expect(dialog?.getAttribute("aria-label")).toBe("Фото 3 из 5");

    await act(async () => {
      browser.close(dialog);
    });
    expect(dialog?.hasAttribute("open")).toBe(false);
    expect(browser.document.activeElement).toBe(second);
    expect(browser.document.documentElement.style.overflow).toBe("");
  });

  it("closes by its button and by a pull down, and not by a swipe to the side", async () => {
    const browser = openBrowser();
    const { dialog, page, second } = await opened(browser);

    await fire(
      browser,
      dialog?.querySelector('button[aria-label="Закрыть"]'),
      "click"
    );
    expect(dialog?.hasAttribute("open")).toBe(false);

    await fire(browser, second, "click");
    await fire(browser, dialog, "pointerdown", {
      clientX: 100,
      clientY: 100,
      isPrimary: true,
    });
    await fire(browser, dialog, "pointermove", { clientX: 300, clientY: 130 });
    await fire(browser, dialog, "pointerup");
    expect(dialog?.hasAttribute("open")).toBe(true);

    await fire(browser, dialog, "pointerdown", {
      clientX: 100,
      clientY: 100,
      isPrimary: true,
    });
    await fire(browser, dialog, "pointermove", { clientX: 110, clientY: 260 });
    await fire(browser, dialog, "pointerup");
    expect(dialog?.hasAttribute("open")).toBe(false);
    expect(page.querySelector("dialog ul")).toBeNull();
  });

  it("holds Telegram's own pull-to-close while it is open", async () => {
    const disableVerticalSwipes = vi.fn<() => void>();
    const enableVerticalSwipes = vi.fn<() => void>();
    const browser = openBrowser();
    Object.assign(browser.window, {
      Telegram: {
        WebApp: {
          disableVerticalSwipes,
          enableVerticalSwipes,
          initData: "query_id=1",
          isVersionAtLeast: () => true,
        },
      },
    });
    const { dialog } = await opened(browser);

    expect(disableVerticalSwipes).toHaveBeenCalledOnce();
    expect(enableVerticalSwipes).not.toHaveBeenCalled();
    await fire(
      browser,
      dialog?.querySelector('button[aria-label="Закрыть"]'),
      "click"
    );
    expect(enableVerticalSwipes).toHaveBeenCalledOnce();
  });
});
