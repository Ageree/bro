import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as linkedom from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardLink } from "@web/components/cards/card-link";
import { Copyable, copyText } from "@web/components/cards/copyable";

const browserGlobals = {
  Element: linkedom.Element,
  HTMLAnchorElement: linkedom.HTMLAnchorElement,
  HTMLButtonElement: linkedom.HTMLButtonElement,
  HTMLElement: linkedom.HTMLElement,
  HTMLInputElement: linkedom.HTMLInputElement,
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

async function mount(browser: ReturnType<typeof openBrowser>, page: ReactNode) {
  const container = browser.document.getElementById("root");
  if (!container) throw new Error("The page has no root.");
  const root = createRoot(container);
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
