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
  /** true when a maxLength===1 box only got the first char of a longer value
   * (F7) — the caller must not treat this as a completed entry. */
  partial?: boolean;
};

export type OtpInputAttrs = {
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  type?: string;
  autocomplete?: string;
  active?: boolean;
  maxLength?: number;
};

/**
 * Pure scoring used to rank a page's visible inputs for OTP/code injection.
 * This is the source of truth for the weights; `TYPE_INTO_PAGE` below runs
 * inside the Cloud tab over CDP `Runtime.evaluate` (no module imports reach
 * it there), so its inline `score()` duplicates this exact arithmetic — keep
 * both in sync (browser-inject-check.ts asserts the literal weights match).
 */
export function scoreOtpInput(attrs: OtpInputAttrs, valueLen: number): number {
  const auto = (attrs.autocomplete ?? "").toLowerCase();
  const bits = [attrs.name, attrs.id, attrs.placeholder, attrs.ariaLabel, attrs.type]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  let n = 0;
  if (auto.includes("one-time-code")) n += 80;
  if (/otp|sms|code|pin|код|подтвержд/.test(bits)) n += 50;
  if (attrs.active) n += 20;
  if (attrs.maxLength === 1 || attrs.maxLength === valueLen) n += 10;
  return n;
}

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
  // Mirrors scoreOtpInput() in browser-cdp.ts — keep the weights in sync.
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
    // No bare "only one input on the page" escape hatch: a score of 0 with no
    // focus signal is not enough evidence this is the right field (F6).
    if (target && (score(target) > 0 || document.activeElement === target)) {
      if (target instanceof HTMLInputElement && target.maxLength === 1 && value.length > 1) {
        // A single maxLength=1 box for a multi-digit value: type only the
        // first char rather than silently overflowing it (F7) — the caller
        // must treat this as incomplete.
        setValue(target, value.slice(0, 1));
        return { typed: true, submitted: false, partial: true };
      }
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
 *
 * `Runtime.evaluate` only ever sees the top-level frame's document — a 3-D
 * Secure ACS challenge or a bank app's push widget is almost always a
 * cross-origin iframe, so its inputs are invisible here. This is by design
 * (no `Target.getTargets`/isolated-world traversal): it fails safe as
 * `typed: false` rather than guessing, and the reliable path for those cases
 * is `queueMessage` to the real Cloud LLM, which can see inside iframes.
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
    const rec = raw as { typed?: unknown; submitted?: unknown; partial?: unknown };
    return {
      typed: rec.typed === true,
      submitted: rec.submitted === true,
      ...(rec.partial === true ? { partial: true } : {}),
    };
  } finally {
    session.close();
  }
}

export { cdpPageUrl } from "../../convex/lib/browserCdp.ts";
