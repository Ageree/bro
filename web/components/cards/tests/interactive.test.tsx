import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as linkedom from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import hotelChoicePhotos from "../../../../docs/cards/examples/hotel-choice-photos.json";
import hotelChoice from "../../../../docs/cards/examples/hotel-choice.json";
import hotelApp from "../../../../docs/cards/examples/hotel-app.json";
import kidPartyDetails from "../../../../docs/cards/examples/kid-party-details.json";
import { CardAnswerScope } from "@web/components/cards/answer";
import { CardLink } from "@web/components/cards/card-link";
import { CardView } from "@web/components/cards/card-view";
import { Copyable, copyText } from "@web/components/cards/copyable";
import { TelegramScope } from "@web/components/cards/telegram";
import {
  type respondReplySchema,
  respondRequestSchema,
} from "@shared/cards/respond";
import { cardSchema } from "@shared/cards/schema";
import * as z from "zod";

/**
 * react-dom decides when it loads whether the page has input events, and
 * without them a typed letter never reaches onChange: the window is in place
 * before it loads, with the `oninput` a browser's document has.
 */
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

const browserGlobals = {
  Element: linkedom.Element,
  HTMLAnchorElement: linkedom.HTMLAnchorElement,
  HTMLButtonElement: linkedom.HTMLButtonElement,
  HTMLElement: linkedom.HTMLElement,
  HTMLFieldSetElement: linkedom.HTMLFieldSetElement,
  HTMLInputElement: linkedom.HTMLInputElement,
  HTMLLabelElement: linkedom.HTMLLabelElement,
  HTMLTextAreaElement: linkedom.HTMLTextAreaElement,
  Node: linkedom.Node,
  ShadowRoot: linkedom.ShadowRoot,
};

function openBrowser() {
  const { document, window } = linkedom.parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const [name, value] of Object.entries(browserGlobals)) {
    vi.stubGlobal(name, value);
  }
  Object.assign(linkedom.HTMLTextAreaElement.prototype, {
    select: () => undefined,
  });
  Object.assign(window, { Telegram: undefined });
  return { document, window };
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(browser: ReturnType<typeof openBrowser>, page: ReactNode) {
  const container = browser.document.getElementById("root");
  if (!container) throw new Error("The page has no root.");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(page);
  });
  return container;
}

async function click(
  browser: ReturnType<typeof openBrowser>,
  node: Element | null
) {
  const event = new browser.window.Event("click", {
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    node?.dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("uses the Clipboard API where the page may", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.resolve()
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    expect(await copyText("XK4P7Q")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("XK4P7Q");
  });

  it("falls back to a hidden field where the API is missing, and cleans it up", async () => {
    const { document } = openBrowser();
    vi.stubGlobal("navigator", {});
    let copied = "";
    Object.assign(document, {
      execCommand: vi.fn<(command: string) => boolean>((command) => {
        copied = document.querySelector("textarea")?.value ?? "";
        return command === "copy";
      }),
    });

    expect(await copyText("XK4P7Q")).toBe(true);
    expect(copied).toBe("XK4P7Q");
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("says so when no way worked", async () => {
    const { document } = openBrowser();
    vi.stubGlobal("navigator", {
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
    });
    Object.assign(document, { execCommand: () => false });

    expect(await copyText("XK4P7Q")).toBe(false);
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});

describe("copyable", () => {
  it("copies the value, says so, and goes back to the button after a moment", async () => {
    vi.useFakeTimers();
    const browser = openBrowser();
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.resolve()
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = await mount(
      browser,
      <Copyable label="Код" value="XK4P7Q" />
    );

    await click(browser, container.querySelector("button"));
    expect(writeText).toHaveBeenCalledWith("XK4P7Q");
    expect(container.querySelector("button")?.textContent).toBe("Скопировано");
    expect(container.querySelector("output")?.textContent).toBe("Скопировано");

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.querySelector("button")?.textContent).toBe("Копировать");
    expect(container.querySelector("output")?.textContent).toBe("");
  });

  it("selects the value when the browser refuses to copy", async () => {
    const browser = openBrowser();
    vi.stubGlobal("navigator", {
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
    });
    Object.assign(browser.document, { execCommand: () => false });
    const selectAllChildren = vi.fn<(node: Node) => void>();
    Object.assign(browser.window, {
      getSelection: () => ({ selectAllChildren }),
    });
    const container = await mount(
      browser,
      <Copyable label="Код" value="XK4P7Q" />
    );

    await click(browser, container.querySelector("button"));
    expect(container.querySelector("button")?.textContent).toBe("Выделено");
    expect(selectAllChildren).toHaveBeenCalledWith(
      container.querySelector("p.select-all")
    );
  });
});

describe("card link", () => {
  const openLink = vi.fn<(url: string) => void>();

  it("hands a web link to Telegram's own opener inside a Mini App", async () => {
    const browser = openBrowser();
    Object.assign(browser.window, { Telegram: { WebApp: { openLink } } });
    const container = await mount(
      browser,
      <CardLink href="https://example.com/a">Открыть</CardLink>
    );

    const event = await click(browser, container.querySelector("a"));
    expect(event.defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenCalledWith("https://example.com/a");
  });

  it("leaves the anchor alone outside Telegram", async () => {
    openLink.mockClear();
    const browser = openBrowser();
    const container = await mount(
      browser,
      <CardLink href="https://example.com/a">Открыть</CardLink>
    );

    const event = await click(browser, container.querySelector("a"));
    expect(event.defaultPrevented).toBe(false);
    expect(openLink).not.toHaveBeenCalled();
  });

  it("leaves a call and an email to the system, even inside a Mini App", async () => {
    openLink.mockClear();
    const browser = openBrowser();
    Object.assign(browser.window, { Telegram: { WebApp: { openLink } } });
    const container = await mount(
      browser,
      <>
        <CardLink href="tel:+74951234567">Позвонить</CardLink>
        <CardLink href="mailto:help@example.com">Написать</CardLink>
      </>
    );

    const [call, mail] = container.querySelectorAll("a");
    expect((await click(browser, call ?? null)).defaultPrevented).toBe(false);
    expect((await click(browser, mail ?? null)).defaultPrevented).toBe(false);
    expect(openLink).not.toHaveBeenCalled();
    expect(call?.getAttribute("target")).toBeNull();
    expect(mail?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

/** Telegram's Mini App object, opened from Bro's button (or not). */
function telegramApp(initData: string) {
  return {
    HapticFeedback: {
      impactOccurred: vi.fn<() => void>(),
      notificationOccurred: vi.fn<(type: string) => void>(),
      selectionChanged: vi.fn<() => void>(),
    },
    close: vi.fn<() => void>(),
    expand: vi.fn<() => void>(),
    initData,
    isVersionAtLeast: () => true,
    openLink: vi.fn<(url: string) => void>(),
    ready: vi.fn<() => void>(),
    setBackgroundColor: vi.fn<(color: string) => void>(),
    setHeaderColor: vi.fn<(color: string) => void>(),
  };
}

/** The server's replies, in order; a thrown error is a lost connection. */
function server(
  ...replies: readonly (z.input<typeof respondReplySchema> | Error)[]
) {
  const queue = [...replies];
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url) => {
      if (url === "/eve/v1/card-answers") {
        return new Response(null, { status: 202 });
      }
      const next = queue.shift();
      if (next === undefined || next instanceof Error) {
        throw next ?? new Error("No reply left.");
      }
      return Response.json(next, {
        status: next.status === "invalid" ? 422 : 200,
      });
    }
  );
  vi.stubGlobal("fetch", fetch);
  const sent = () =>
    fetch.mock.calls.flatMap(([url, init]) =>
      url.startsWith("/api/cards/")
        ? [respondRequestSchema.parse(JSON.parse(z.string().parse(init?.body)))]
        : []
    );
  return { fetch, sent };
}

/** The tab's storage, as the page keeps its draft in it. */
function storage() {
  const entries = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  });
  return entries;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Whether each box is ticked: React sets `checked` as a property, not an attribute. */
const ticked = (container: Element, selector: string) =>
  [...container.querySelectorAll(selector)].map(
    (input) => input instanceof HTMLInputElement && input.checked
  );

const buttonOf = (container: Element, label: string) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label
  ) ?? null;

describe("a card that asks", () => {
  const hotel = cardSchema.parse(hotelChoice);
  const appCard = cardSchema.parse(hotelApp);
  const party = cardSchema.parse(kidPartyDetails);
  const link = "A".repeat(43);
  const keptAnswer = {
    answer: { action: "continue", values: { hotel: "admiral" } },
    delivery: "received" as const,
    status: "sent" as const,
  };

  async function page(
    card: typeof hotel,
    initData = "signed-launch-data",
    browser = openBrowser()
  ) {
    const app = telegramApp(initData);
    Object.assign(browser.window, { Telegram: { WebApp: app } });
    const container = await mount(
      browser,
      <TelegramScope>
        <CardAnswerScope card={card} link={link} revision={1}>
          <CardView card={card} />
        </CardAnswerScope>
      </TelegramScope>
    );
    await settle();
    return {
      app,
      container,
      press: async (node: Element | null) => {
        await click(browser, node);
        await settle();
      },
      type: async (field: Element | null, value: string) => {
        if (!(field instanceof linkedom.HTMLElement)) {
          throw new Error("No field.");
        }
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(field),
          "value"
        )?.set?.call(field, value);
        await act(async () => {
          field.dispatchEvent(
            new browser.window.Event("input", { bubbles: true })
          );
        });
      },
    };
  }

  it("calculates nights locally, filters by price, and keeps an over-budget pick visible", async () => {
    storage();
    const { sent } = server({ status: "open" });
    const { container, press, type } = await page(appCard);
    expect(container.textContent).toContain("12 800 ₽ за 2");
    await press(
      container.querySelector('button[aria-label="Увеличить: Ночей"]')
    );
    expect(container.textContent).toContain("19 200 ₽ за 3");
    await type(container.querySelector('input[type="range"]'), "5500");
    expect(container.textContent).toContain("Показано 2 из 3");
    expect(container.textContent).toContain("Не подходит под бюджет");
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    await press(container.querySelector('input[value="loft"]'));
    expect(container.textContent).toContain("Показано 1 из 3");
    expect(container.textContent).toContain("15 600 ₽ за 3");
    expect(sent().map((body) => body.kind)).toEqual(["open"]);
  });

  it("accepts repeated intents without locking controls or requiring the final pick", async () => {
    storage();
    const { sent } = server(
      { status: "open" },
      { status: "intent", outcome: "received" },
      { status: "intent", outcome: "replaced" }
    );
    const { container, press } = await page(appCard);
    await press(buttonOf(container, "Показать ещё варианты"));
    expect(container.textContent).toContain("Запрос принят");
    expect(container.textContent).toContain("Бро работает");
    expect(
      container.querySelector('input[type="range"]')?.hasAttribute("disabled")
    ).toBe(false);
    await press(buttonOf(container, "Показать ещё варианты"));
    expect(container.textContent).toContain("Последнее нажатие принято");
    expect(sent().filter((body) => body.kind === "send")).toHaveLength(2);
    expect(buttonOf(container, "Выбрать и забронировать")).not.toBeNull();
  });

  it("rebases an open revision without a reload, preserving edits and naming a removed pick", async () => {
    vi.useFakeTimers();
    const drafts = storage();
    const next = cardSchema.parse({
      ...appCard,
      note: "Нашёл ещё один вариант.",
      blocks: appCard.blocks.map((block) =>
        block.type === "choice"
          ? {
              ...block,
              initial: [],
              options: block.options.filter(
                (option) => option.value !== "nevsky_dvor"
              ),
            }
          : block
      ),
    });
    const { sent } = server(
      { status: "open" },
      {
        status: "watch",
        revision: 2,
        card: next,
        press: { action: "more", kind: "intent", revision: 1, stage: "done" },
      }
    );
    const { container, type, press } = await page(appCard);
    await type(container.querySelector("textarea"), "Тихий этаж");
    await press(
      container.querySelector('button[aria-label="Увеличить: Ночей"]')
    );
    await advance(500);
    expect(container.textContent).toContain("Обновлено");
    expect(container.textContent).toContain("Нашёл ещё один вариант");
    expect(container.textContent).toContain("Проверьте выбор: Отель");
    expect(container.querySelector("textarea")?.value).toBe("Тихий этаж");
    expect(JSON.parse(drafts.get(`bro-card:${link}:2`) ?? "{}")).toMatchObject({
      nights: "3",
      wish: "Тихий этаж",
      hotel: "",
    });
    expect(container.querySelector('[class*="animate-pulse"]')).not.toBeNull();
    expect(sent().map((body) => body.kind)).toEqual(["open", "watch"]);
  });

  it("pauses hidden polling, backs off failures, and stops after a finished submit", async () => {
    vi.useFakeTimers();
    storage();
    const browser = openBrowser();
    let hidden = true;
    Object.defineProperty(browser.document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    const { sent } = server({ status: "open" }, new Error("offline"), {
      status: "watch",
      revision: 1,
      answer: { answer: keptAnswer.answer, delivery: "delivered" },
      press: { action: "continue", kind: "submit", revision: 1, stage: "done" },
    });
    const { container } = await page(appCard, "signed-launch-data", browser);
    await advance(60_000);
    expect(sent()).toHaveLength(1);
    hidden = false;
    await act(async () => {
      browser.document.dispatchEvent(
        new browser.window.Event("visibilitychange")
      );
    });
    expect(sent()).toHaveLength(2);
    await advance(39_999);
    expect(sent()).toHaveLength(2);
    await advance(1);
    expect(sent()).toHaveLength(3);
    expect(container.textContent).toContain("Отправлено");
    await advance(120_000);
    expect(sent()).toHaveLength(3);
  });

  it("checks a finished card once on return, so a new revision can reopen it without background polling", async () => {
    vi.useFakeTimers();
    storage();
    const browser = openBrowser();
    let hidden = false;
    Object.defineProperty(browser.document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    const done = {
      action: "continue",
      kind: "submit" as const,
      revision: 1,
      stage: "done" as const,
    };
    const { sent } = server(
      { status: "open" },
      {
        status: "watch",
        revision: 1,
        answer: { answer: keptAnswer.answer, delivery: "delivered" },
        press: done,
      },
      {
        status: "watch",
        revision: 2,
        card: { ...appCard, note: "Появился результат после возвращения." },
        press: done,
      }
    );
    const { container } = await page(appCard, "signed-launch-data", browser);
    await advance(500);
    expect(container.textContent).toContain("Отправлено");
    await advance(60_000);
    expect(sent()).toHaveLength(2);
    hidden = true;
    await act(async () => {
      browser.document.dispatchEvent(
        new browser.window.Event("visibilitychange")
      );
    });
    expect(sent()).toHaveLength(2);
    hidden = false;
    await act(async () => {
      browser.document.dispatchEvent(
        new browser.window.Event("visibilitychange")
      );
    });
    expect(sent()).toHaveLength(3);
    expect(container.textContent).toContain(
      "Появился результат после возвращения"
    );
    expect(buttonOf(container, "Выбрать и забронировать")).not.toBeNull();
  });

  it("never overlaps watch requests and ignores an aborted watch from before a press", async () => {
    vi.useFakeTimers();
    storage();
    let finish: ((response: Response) => void) | undefined;
    let watches = 0;
    let firstSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/eve/v1/card-answers")
        return new Response(null, { status: 202 });
      const body = respondRequestSchema.parse(
        JSON.parse(z.string().parse(init?.body))
      );
      if (body.kind === "open") return Response.json({ status: "open" });
      if (body.kind === "send")
        return Response.json({ status: "intent", outcome: "received" });
      watches += 1;
      if (watches > 1) return Response.json({ status: "watch", revision: 1 });
      firstSignal = init?.signal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const { container, press } = await page(appCard);
    await advance(500);
    await advance(60_000);
    expect(watches).toBe(1);
    await press(buttonOf(container, "Показать ещё варианты"));
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      finish?.(
        Response.json({
          status: "watch",
          revision: 2,
          card: { ...appCard, title: "Old response" },
        })
      );
    });
    expect(container.textContent).not.toContain("Old response");
    await advance(300);
    expect(watches).toBe(2);
  });

  it("lets the person choose, sends the answer with the button, and shows it kept", async () => {
    const keptDrafts = storage();
    const { fetch, sent } = server({ status: "open" }, keptAnswer);
    const { app, container, press, type } = await page(hotel);

    const legends = [...container.querySelectorAll("fieldset > legend")];
    expect(legends.map((legend) => legend.textContent)).toEqual([
      "Отель",
      "Что нужно дополнительно",
    ]);
    const radios = [...container.querySelectorAll('input[type="radio"]')];
    expect(ticked(container, 'input[type="radio"]')).toEqual([
      true,
      false,
      false,
    ]);
    await press(radios[1] ?? null);
    expect(app.HapticFeedback.selectionChanged).toHaveBeenCalled();
    await type(container.querySelector("textarea"), "тихий этаж");
    expect(
      JSON.parse(keptDrafts.get(`bro-card:${link}:1`) ?? "{}")
    ).toMatchObject({ hotel: "admiral", wish: "тихий этаж" });

    await press(buttonOf(container, "Продолжить с выбором"));

    expect(sent()).toEqual([
      { initData: "signed-launch-data", kind: "open", revision: 1 },
      {
        action: "continue",
        initData: "signed-launch-data",
        kind: "send",
        revision: 1,
        values: { extras: [], hotel: "admiral", wish: "тихий этаж" },
      },
    ]);
    expect(fetch).toHaveBeenCalledWith("/eve/v1/card-answers", {
      keepalive: true,
      method: "POST",
    });
    expect(container.textContent).toContain("Отправлено");
    expect(container.textContent).toContain("Ответ у Бро");
    expect(buttonOf(container, "Показать другие")).toBeNull();
    expect(
      [...container.querySelectorAll("input")].every((input) =>
        input.hasAttribute("disabled")
      )
    ).toBe(true);
    expect(app.HapticFeedback.notificationOccurred).toHaveBeenCalledWith(
      "success"
    );
    expect(keptDrafts.size).toBe(0);

    await press(buttonOf(container, "Вернуться к Бро"));
    expect(app.close).toHaveBeenCalledOnce();
  });

  it("holds the main button back until the required questions are filled, and shows what is missing", async () => {
    storage();
    const { sent } = server({ status: "open" });
    const focus = vi.spyOn(linkedom.HTMLElement.prototype, "focus");
    const { container, press } = await page(party);

    const plan = buttonOf(container, "Подобрать варианты");
    expect(plan?.getAttribute("aria-disabled")).toBe("true");
    await press(plan);

    expect(sent()).toHaveLength(1);
    const date = container.querySelector("#card-question-date");
    expect(date?.getAttribute("aria-invalid")).toBe("true");
    expect(date?.getAttribute("aria-describedby")).toBe(
      "card-question-date-error"
    );
    expect(
      container.querySelector("#card-question-date-error")?.textContent
    ).toBe("Заполните поле.");
    expect(
      container.querySelector("#card-question-format-error")?.textContent
    ).toBe("Выберите вариант.");
    expect(focus.mock.contexts[0]).toBe(date);
    expect(
      container.querySelector('label[for="card-question-budget"]')?.textContent
    ).toBe("Бюджет");
    expect(
      container
        .querySelector("#card-question-budget")
        ?.getAttribute("aria-describedby")
    ).toBe("card-question-budget-hint");
    expect(container.textContent).toContain("₽");
    focus.mockRestore();
  });

  it("brings the draft back after a reload, and sends nothing until a button is pressed", async () => {
    const keptDrafts = storage();
    keptDrafts.set(
      `bro-card:${link}:1`,
      JSON.stringify({ hotel: "loft", wish: "с видом во двор" })
    );
    const { sent } = server({ status: "open" });
    const { container } = await page(hotel);

    expect(ticked(container, 'input[type="radio"]')).toEqual([
      false,
      false,
      true,
    ]);
    expect(container.querySelector("textarea")?.value).toBe("с видом во двор");
    expect(sent().map((body) => body.kind)).toEqual(["open"]);
  });

  it("shows the server's word under the question, and retries a send that was lost", async () => {
    storage();
    const { sent } = server(
      { status: "open" },
      {
        issues: [{ id: "hotel", message: "Такого варианта в карточке нет." }],
        status: "invalid",
      },
      new Error("offline"),
      keptAnswer
    );
    const { container, press } = await page(hotel);

    await press(buttonOf(container, "Продолжить с выбором"));
    expect(
      container.querySelector("#card-question-hotel-error")?.textContent
    ).toBe("Такого варианта в карточке нет.");

    await press(buttonOf(container, "Продолжить с выбором"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Не получилось связаться с Бро"
    );
    await press(buttonOf(container, "Повторить"));
    expect(sent()).toHaveLength(4);
    expect(container.textContent).toContain("Отправлено");
  });

  it("lets someone else read the card but not answer it, and shows them no answer", async () => {
    storage();
    const { sent } = server({ status: "foreign" });
    const { container } = await page(hotel);

    expect(container.textContent).toContain(
      "Эту карточку Бро прислал другому человеку"
    );
    expect(buttonOf(container, "Продолжить с выбором")).toBeNull();
    expect(ticked(container, 'input[type="radio"]')).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      [...container.querySelectorAll("input")].every((input) =>
        input.hasAttribute("disabled")
      )
    ).toBe(true);
    expect(sent()).toHaveLength(1);
  });

  it("asks nothing outside Telegram and says where to answer", async () => {
    storage();
    const { fetch } = server();
    const { container } = await page(hotel, "");

    expect(fetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Ответить можно в Telegram");
  });
});

const tiles = (container: Element) => [
  ...container.querySelectorAll("fieldset label"),
];

describe("a choice with photos", () => {
  const link = "A".repeat(43);
  const hotels = cardSchema.parse(hotelChoicePhotos);
  const gifts = cardSchema.parse({
    actions: [
      { label: "Подобрать доставку", primary: true, submit: "deliver" },
    ],
    blocks: [
      {
        id: "gifts",
        label: "Что из этого понравится",
        layout: "tiles",
        multiple: true,
        options: ["scarf", "teapot", "lamp", "book"].map((value) => ({
          detail: "Доставят к субботе",
          photo: {
            alt: `Подарок ${value}`,
            url: `https://example.com/${value}.jpg`,
          },
          side: "3 900 ₽",
          title: `Подарок ${value}`,
          value,
        })),
        type: "choice",
      },
    ],
    title: "Подарок маме",
  });

  async function page(card: typeof hotels) {
    const browser = openBrowser();
    Object.assign(browser.window, {
      Telegram: { WebApp: telegramApp("signed-launch-data") },
    });
    const container = await mount(
      browser,
      <TelegramScope>
        <CardAnswerScope card={card} link={link} revision={1}>
          <CardView card={card} />
        </CardAnswerScope>
      </TelegramScope>
    );
    await settle();
    return {
      container,
      press: async (node: Element | null | undefined) => {
        await click(browser, node ?? null);
        await settle();
      },
    };
  }

  it("picks a hotel from a strip of photo cards, shows the pick on its photo, and opens nothing over the choice", async () => {
    storage();
    const { sent } = server(
      { status: "open" },
      {
        answer: { action: "continue", values: { hotel: "admiral" } },
        delivery: "received",
        status: "sent",
      }
    );
    const { container, press } = await page(hotels);

    const strip = container.querySelector(
      'fieldset section[aria-roledescription="карусель"]'
    );
    expect(strip?.querySelectorAll("ul > li > label")).toHaveLength(3);
    expect(
      container.querySelector('fieldset [aria-haspopup="dialog"]')
    ).toBeNull();
    const [first, second] = tiles(container);
    expect(
      first?.querySelector("span.aspect-4\\/3 > img")?.getAttribute("alt")
    ).toBe("Холл отеля «Невский Двор» с камином");
    expect(first?.className).toContain("ring-1");
    expect(second?.className).toContain("border-bro-line");
    expect(
      first?.querySelector('span[aria-hidden="true"]')?.className
    ).toContain("group-has-[img]/tile:absolute");

    await press(container.querySelectorAll('input[type="radio"]')[1]);
    expect(ticked(container, 'input[type="radio"]')).toEqual([
      false,
      true,
      false,
    ]);
    expect(second?.className).toContain("ring-1");
    expect(first?.className).not.toContain("ring-1");

    await press(buttonOf(container, "Продолжить с выбором"));
    expect(sent().at(-1)).toMatchObject({
      kind: "send",
      values: { hotel: "admiral" },
    });
    expect(
      [...container.querySelectorAll("input")].every((input) =>
        input.hasAttribute("disabled")
      )
    ).toBe(true);
    expect(second?.className).toContain("cursor-default");
  });

  it("sets tiles two to a row with a tick on each photo, and says what is missing", async () => {
    storage();
    const { sent } = server({ status: "open" });
    const { container, press } = await page(gifts);

    expect(
      container.querySelector("fieldset > div.grid-cols-2")?.children
    ).toHaveLength(4);
    expect(
      tiles(container).map((tile) =>
        tile.querySelector("img")?.getAttribute("alt")
      )
    ).toEqual([
      "Подарок scarf",
      "Подарок teapot",
      "Подарок lamp",
      "Подарок book",
    ]);
    expect(
      tiles(container)[0]?.querySelector('span[aria-hidden="true"]')?.className
    ).toContain("rounded-[6px]");

    await press(buttonOf(container, "Подобрать доставку"));
    expect(sent()).toHaveLength(1);
    expect(
      container.querySelector("#card-question-gifts-error")?.textContent
    ).toBe("Выберите вариант.");
    expect(
      container
        .querySelector('input[type="checkbox"]')
        ?.getAttribute("aria-invalid")
    ).toBe("true");

    const boxes = container.querySelectorAll('input[type="checkbox"]');
    await press(boxes[0]);
    await press(boxes[2]);
    expect(ticked(container, 'input[type="checkbox"]')).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(tiles(container)[2]?.className).toContain("ring-1");
    const tick = tiles(container)[2]?.querySelector('span[aria-hidden="true"]');
    expect(tick?.className).toContain("bg-foreground");
    expect(tick?.className).not.toContain("bg-card");
  });
});
