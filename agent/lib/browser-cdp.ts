import {
  cdpCurrentUrl,
  listCdpTargets,
  pickCdpPage,
} from "../../convex/lib/browserCdp.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type CdpReply = {
  id?: number;
  error?: { message?: string };
  result?: { result?: { value?: unknown; type?: string } };
};

type CdpSession = {
  call: (method: string, params?: Record<string, unknown>) => Promise<CdpReply>;
  close: () => void;
};

async function openCdpPage(cdpUrl: string): Promise<CdpSession> {
  const targets = await listCdpTargets(cdpUrl);
  const page = pickCdpPage(targets);
  const wsUrl = page?.webSocketDebuggerUrl?.trim();
  if (!wsUrl) throw new Error("cdp page missing websocket");

  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, (reply: CdpReply) => void>();
  let nextId = 1;

  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cdp websocket timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cdp websocket error"));
    });
  });

  ws.addEventListener("message", (ev) => {
    let reply: CdpReply;
    try {
      reply = JSON.parse(String(ev.data)) as CdpReply;
    } catch {
      return;
    }
    if (typeof reply.id !== "number") return;
    const wait = pending.get(reply.id);
    if (!wait) return;
    pending.delete(reply.id);
    wait(reply);
  });

  await opened;

  const call = async (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<CdpReply> => {
    const id = nextId++;
    const reply = await new Promise<CdpReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cdp ${method} timeout`)), 15_000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error?.message) throw new Error(`cdp ${method}: ${reply.error.message}`);
    return reply;
  };

  return {
    call,
    close: () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Open `target` in the Cloud browser tab. Does not wait for the Cloud LLM.
 * Returns the tab URL after navigate (may still be about:blank on failure).
 */
export async function cdpNavigate(
  cdpUrl: string,
  target: string,
  ms = 20_000,
): Promise<string | undefined> {
  const session = await openCdpPage(cdpUrl);
  try {
    await session.call("Page.enable");
    await session.call("Page.navigate", { url: target });
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const url = cdpCurrentUrl(await listCdpTargets(cdpUrl));
      if (url && url !== "about:blank" && !url.startsWith("chrome-error://")) {
        return url;
      }
      await sleep(400);
    }
    return cdpCurrentUrl(await listCdpTargets(cdpUrl));
  } finally {
    session.close();
  }
}

export type CdpTypeResult = {
  typed: boolean;
  submitted: boolean;
};

const TYPE_INTO_PAGE = `function (raw) {
  const value = String(raw ?? "");
  if (!value) return { typed: false, submitted: false };
  const visible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.disabled || el.readOnly) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
  };
  const setValue = (el, next) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: next, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const inputs = Array.from(document.querySelectorAll("input, textarea")).filter((el) => {
    if (!visible(el)) return false;
    if (el instanceof HTMLInputElement) {
      if (["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio", "password"].includes(el.type)) {
        return false;
      }
    }
    return true;
  });
  const score = (el) => {
    const auto = (el.autocomplete || "").toLowerCase();
    const bits = [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.type]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    let n = 0;
    if (auto.includes("one-time-code")) n += 80;
    if (/otp|sms|code|pin|код|подтвержд/.test(bits)) n += 50;
    if (document.activeElement === el) n += 20;
    if (el.maxLength === 1 || el.maxLength === value.length) n += 10;
    return n;
  };
  const boxes = inputs.filter((el) => el instanceof HTMLInputElement && el.maxLength === 1);
  let typed = false;
  if (boxes.length >= 4 && boxes.length <= 8 && /^\\d+$/.test(value)) {
    const chars = value.slice(0, boxes.length).split("");
    boxes.forEach((el, i) => setValue(el, chars[i] ?? ""));
    typed = true;
  } else {
    const ranked = [...inputs].sort((a, b) => score(b) - score(a));
    const target = ranked[0];
    if (target && (score(target) > 0 || document.activeElement === target || ranked.length === 1)) {
      setValue(target, value);
      typed = true;
    }
  }
  if (!typed) return { typed: false, submitted: false };
  const forbid = /заказать|поехали|оплатить|купить|pay|order/i;
  const allow = /^(войти|подтвердить|продолжить|далее|отправить|verify|continue|submit|confirm|next|sign in|log in)$/i;
  const buttons = Array.from(document.querySelectorAll("button, [role='button'], input[type=submit]"));
  for (const btn of buttons) {
    if (!visible(btn)) continue;
    const label = (btn.innerText || btn.value || btn.getAttribute("aria-label") || "").trim();
    if (!label || forbid.test(label) || !allow.test(label)) continue;
    btn.click();
    return { typed: true, submitted: true };
  }
  return { typed: true, submitted: false };
}`;

/**
 * Type digits or a short correction into the live Cloud tab.
 * Never fills a password field. Never clicks «Заказать».
 */
export async function cdpTypeIntoPage(
  cdpUrl: string,
  text: string,
): Promise<CdpTypeResult> {
  const value = text.trim();
  if (!value) return { typed: false, submitted: false };
  const session = await openCdpPage(cdpUrl);
  try {
    const reply = await session.call("Runtime.evaluate", {
      expression: `(${TYPE_INTO_PAGE})(${JSON.stringify(value)})`,
      returnByValue: true,
      awaitPromise: false,
    });
    const raw = reply.result?.result?.value;
    if (!raw || typeof raw !== "object") return { typed: false, submitted: false };
    const rec = raw as { typed?: unknown; submitted?: unknown };
    return {
      typed: rec.typed === true,
      submitted: rec.submitted === true,
    };
  } finally {
    session.close();
  }
}

export { cdpPageUrl } from "../../convex/lib/browserCdp.ts";
