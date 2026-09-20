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
  result?: { result?: { value?: unknown; type?: string } } & Record<string, unknown>;
};

type CdpEventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

type CdpSession = {
  call: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<CdpReply>;
  on: (method: string, handler: CdpEventHandler) => void;
  close: () => void;
};

async function openCdpPage(cdpUrl: string): Promise<CdpSession> {
  const targets = await listCdpTargets(cdpUrl);
  const page = pickCdpPage(targets);
  const wsUrl = page?.webSocketDebuggerUrl?.trim();
  if (!wsUrl) throw new Error("cdp page missing websocket");

  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, (reply: CdpReply) => void>();
  const handlers = new Map<string, CdpEventHandler[]>();
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
    let message: CdpReply & { method?: string; params?: unknown; sessionId?: string };
    try {
      message = JSON.parse(String(ev.data)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const wait = pending.get(message.id);
      if (!wait) return;
      pending.delete(message.id);
      wait(message);
      return;
    }
    // An event, not a reply. `Target.attachedToTarget` is the only one that
    // matters here: with `flatten: true` it is how a cross-process iframe
    // (3-D Secure, a bank's push widget) announces the session id its own
    // renderer answers on.
    if (typeof message.method !== "string") return;
    const listeners = handlers.get(message.method);
    if (!listeners) return;
    const params =
      message.params && typeof message.params === "object"
        ? (message.params as Record<string, unknown>)
        : {};
    for (const listener of listeners) {
      try {
        listener(params, message.sessionId);
      } catch {
        /* a listener must never take the socket down */
      }
    }
  });

  await opened;

  const call = async (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<CdpReply> => {
    const id = nextId++;
    const reply = await new Promise<CdpReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cdp ${method} timeout`)), 15_000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      ws.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
    if (reply.error?.message) throw new Error(`cdp ${method}: ${reply.error.message}`);
    return reply;
  };

  return {
    call,
    on: (method, handler) => {
      const listeners = handlers.get(method);
      if (listeners) listeners.push(handler);
      else handlers.set(method, [handler]);
    },
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
  /** How many frame contexts were searched (1 = the top document alone). */
  searched?: number;
  /** true when the value landed in an embedded frame rather than the page
   * itself — the 3-D Secure / bank-widget case. */
  inFrame?: boolean;
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
 * This is the source of truth for the weights; `INJECT_PROGRAM` below runs
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

/**
 * What a run of 4-8 single-char boxes fed an all-digit value is worth when
 * frames are compared against each other.
 *
 * Inside one document the boxes always win outright — that branch predates
 * the frame walk and is unchanged. The number only matters across frames, and
 * it is set so a split OTP widget outranks an ordinary field (≤90) but still
 * loses to one that says outright it wants a one-time code (≥100 once any
 * second signal lands). Scored box by box a real widget is worth ~10 each and
 * would lose to almost anything.
 */
export const BOXES_SCORE = 100;

/**
 * What an EMBEDDED frame must score before it may take the code away from the
 * page's own document: a naming signal (`otp`/`code`/`код`/`pin`, or an
 * outright `autocomplete="one-time-code"`), not merely a focused input.
 *
 * Inside the page the human's errand opened, a bare focus signal is decent
 * evidence. In a frame the page embedded from somewhere else it is not — it
 * is exactly what an unrelated widget that happens to autofocus looks like,
 * and a one-time code is not something to hand over on a guess. A real 3-D
 * Secure field names itself; one that does not falls back to the Cloud
 * session, which is where it went before any of this existed.
 */
/** Frames smaller than this hold no real form — a tracking pixel or a
 *  collapsed ad slot must never be offered a one-time code. */
export const MIN_FRAME_SCORE = 50;

export const MIN_FRAME_WIDTH = 100;
export const MIN_FRAME_HEIGHT = 40;

/**
 * One program, two modes. `apply: false` only reports how good this frame's
 * best candidate is, so every frame can be ranked before anything is typed
 * anywhere; `apply: true` performs the entry in the frame that won. Running
 * it as one function keeps the weights, the visibility rules and the
 * never-click list in a single place — two copies would drift the first time
 * one of them is fixed.
 */
const INJECT_PROGRAM = `function (raw, apply) {
  const value = String(raw ?? "");
  const miss = { ok: false, score: 0, typed: false, submitted: false };
  if (!value) return miss;
  // A frame too small to hold a real form (tracking pixel, collapsed ad slot,
  // a 0x0 helper iframe) is never where a code belongs.
  if (window.innerWidth < ${MIN_FRAME_WIDTH} || window.innerHeight < ${MIN_FRAME_HEIGHT}) return miss;
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
  const useBoxes = boxes.length >= 4 && boxes.length <= 8 && /^\\d+$/.test(value);
  const ranked = [...inputs].sort((a, b) => score(b) - score(a));
  const target = useBoxes ? null : ranked[0];
  // No bare "only one input on the page" escape hatch: a score of 0 with no
  // focus signal is not enough evidence this is the right field (F6).
  const targetOk = Boolean(target && (score(target) > 0 || document.activeElement === target));
  if (!useBoxes && !targetOk) return miss;
  // A single maxLength=1 box for a multi-digit value: only the first char can
  // go in, so the caller must treat the entry as incomplete (F7).
  const partial = Boolean(
    !useBoxes && target instanceof HTMLInputElement && target.maxLength === 1 && value.length > 1,
  );
  if (!apply) {
    return { ok: true, score: useBoxes ? ${BOXES_SCORE} : score(target), partial: partial, typed: false, submitted: false };
  }
  let typed = false;
  if (useBoxes) {
    const chars = value.slice(0, boxes.length).split("");
    boxes.forEach((el, i) => setValue(el, chars[i] ?? ""));
    typed = true;
  } else if (partial) {
    setValue(target, value.slice(0, 1));
    return { ok: true, typed: true, submitted: false, partial: true };
  } else {
    setValue(target, value);
    typed = true;
  }
  if (!typed) return miss;
  const forbid = /заказать|поехали|оплатить|купить|pay|order/i;
  const allow = /^(войти|подтвердить|продолжить|далее|отправить|verify|continue|submit|confirm|next|sign in|log in)$/i;
  const buttons = Array.from(document.querySelectorAll("button, [role='button'], input[type=submit]"));
  for (const btn of buttons) {
    if (!visible(btn)) continue;
    const label = (btn.innerText || btn.value || btn.getAttribute("aria-label") || "").trim();
    if (!label || forbid.test(label) || !allow.test(label)) continue;
    btn.click();
    return { ok: true, typed: true, submitted: true, partial: false };
  }
  return { ok: true, typed: true, submitted: false, partial: false };
}`;

/** One searchable JS context: a frame, and the CDP session that owns it. */
type FrameContext = {
  contextId: number;
  sessionId?: string;
  url?: string;
  /** 0 = the page's own main frame. Everything deeper is embedded content. */
  depth: number;
};

/** Depth of embedding still worth walking. A 3-D Secure form is at 1, a
 *  processor that wraps the bank's own page puts it at 2; past 3 there is
 *  nothing but ad furniture. */
const MAX_FRAME_DEPTH = 3;
/** Hard cap on contexts probed, so a page full of ad slots cannot turn one
 *  code entry into a hundred round trips. */
const MAX_CONTEXTS = 24;
/** `Target.setAutoAttach` reports existing children through events; give them
 *  a moment to land before walking what arrived. */
const ATTACH_SETTLE_MS = 300;

type ProbeResult = { ok?: boolean; score?: number; partial?: boolean };

function frameIdsFromTree(
  raw: unknown,
): { id: string; url?: string; depth: number }[] {
  const out: { id: string; url?: string; depth: number }[] = [];
  // Depth is counted per frame, not per session: a same-renderer iframe shares
  // its parent's session and would otherwise report as the page itself.
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    const frame = rec.frame as Record<string, unknown> | undefined;
    const id = frame && typeof frame.id === "string" ? frame.id : undefined;
    if (id) {
      out.push({
        id,
        ...(typeof frame?.url === "string" ? { url: frame.url as string } : {}),
        depth,
      });
    }
    const kids = rec.childFrames;
    if (Array.isArray(kids)) for (const kid of kids) walk(kid, depth + 1);
  };
  const root = (raw as Record<string, unknown> | undefined)?.frameTree;
  walk(root, 0);
  return out;
}

/**
 * Every JS context worth searching, top document first.
 *
 * Two mechanisms, because a browser has two kinds of embedded frame and
 * neither one covers the other. A same-process iframe lives in the page's own
 * renderer and is reached by making an isolated world for its frame id. A
 * cross-process one (an OOPIF — which is what a bank's 3-D Secure challenge
 * almost always is) has its own renderer and answers only on its own session,
 * which `Target.setAutoAttach` hands over.
 */
async function collectContexts(session: CdpSession): Promise<FrameContext[]> {
  const out: FrameContext[] = [];
  const attached: { sessionId: string; depth: number }[] = [];

  session.on("Target.attachedToTarget", (params) => {
    const sessionId = params.sessionId;
    const info = params.targetInfo as Record<string, unknown> | undefined;
    if (typeof sessionId !== "string" || !info) return;
    // Only embedded documents. A worker or a service worker has no DOM, and a
    // popup window is not the page the human is looking at.
    if (info.type !== "iframe" && info.type !== "page") return;
    attached.push({ sessionId, depth: 1 });
  });

  const walk = async (sessionId: string | undefined, depth: number): Promise<void> => {
    if (depth > MAX_FRAME_DEPTH || out.length >= MAX_CONTEXTS) return;
    await session.call("Page.enable", {}, sessionId).catch(() => undefined);
    await session
      .call(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId,
      )
      .catch(() => undefined);
    const tree = await session
      .call("Page.getFrameTree", {}, sessionId)
      .catch(() => undefined);
    for (const frame of frameIdsFromTree(tree?.result)) {
      if (out.length >= MAX_CONTEXTS) return;
      if (depth + frame.depth > MAX_FRAME_DEPTH) continue;
      // A frame that belongs to another renderer is listed here but has no
      // context to make in this one — it arrives through its own session
      // instead, so the failure is expected and silent.
      const world = await session
        .call(
          "Page.createIsolatedWorld",
          { frameId: frame.id, worldName: "bro-inject" },
          sessionId,
        )
        .catch(() => undefined);
      const contextId = world?.result?.executionContextId;
      if (typeof contextId !== "number") continue;
      out.push({
        contextId,
        ...(sessionId ? { sessionId } : {}),
        ...(frame.url ? { url: frame.url } : {}),
        depth: depth + frame.depth,
      });
    }
  };

  await walk(undefined, 0);
  // Children announce themselves asynchronously; walking them is what turns a
  // cross-process 3-D Secure frame from invisible into searchable.
  let cursor = 0;
  for (let round = 0; round < MAX_FRAME_DEPTH; round++) {
    await sleep(ATTACH_SETTLE_MS);
    const batch = attached.slice(cursor);
    cursor = attached.length;
    if (batch.length === 0) break;
    for (const child of batch) {
      if (out.length >= MAX_CONTEXTS) break;
      await walk(child.sessionId, child.depth + round);
    }
  }
  return out;
}

function probeOf(reply: CdpReply | undefined): ProbeResult {
  const raw = reply?.result?.result?.value;
  if (!raw || typeof raw !== "object") return {};
  return raw as ProbeResult;
}

function hostOf(url: string | undefined): string {
  if (!url) return "frame";
  try {
    return new URL(url).host || "frame";
  } catch {
    return "frame";
  }
}

/**
 * Type digits or a short correction into the live Cloud tab — in the top
 * document or in any frame embedded in it.
 * Never fills a password field. Never clicks «Заказать».
 *
 * The frame walk is the whole point. `Runtime.evaluate` against the page
 * alone only ever sees the top-level document, and a 3-D Secure challenge or
 * a bank app's push widget is almost always a cross-origin iframe, so until
 * this existed every bank code failed as `typed: false` and had to be handed
 * back to the Cloud LLM. Each frame is ranked with the same scoring before
 * anything is entered anywhere, and the top document wins a tie — a code is
 * typed once, in the single best-matching field on the whole page, or not at
 * all.
 */
export async function cdpTypeIntoPage(
  cdpUrl: string,
  text: string,
): Promise<CdpTypeResult> {
  const value = text.trim();
  if (!value) return { typed: false, submitted: false };
  const session = await openCdpPage(cdpUrl);
  try {
    const contexts = await collectContexts(session);
    if (contexts.length === 0) return { typed: false, submitted: false, searched: 0 };
    const probe = `(${INJECT_PROGRAM})(${JSON.stringify(value)}, false)`;
    const scored = await Promise.all(
      contexts.map(async (ctx) => {
        const reply = await session
          .call(
            "Runtime.evaluate",
            {
              expression: probe,
              contextId: ctx.contextId,
              returnByValue: true,
              awaitPromise: false,
            },
            ctx.sessionId,
          )
          .catch(() => undefined);
        return { ctx, probe: probeOf(reply) };
      }),
    );
    // Strictly greater, walked in collection order, so the top document keeps
    // a tie and an embedded frame only wins by scoring higher on its own.
    let best: (typeof scored)[number] | undefined;
    for (const candidate of scored) {
      if (candidate.probe.ok !== true) continue;
      const score = candidate.probe.score ?? 0;
      if (candidate.ctx.depth > 0 && score < MIN_FRAME_SCORE) continue;
      if (!best || score > (best.probe.score ?? 0)) best = candidate;
    }
    if (!best) {
      return { typed: false, submitted: false, searched: contexts.length };
    }
    const reply = await session.call(
      "Runtime.evaluate",
      {
        expression: `(${INJECT_PROGRAM})(${JSON.stringify(value)}, true)`,
        contextId: best.ctx.contextId,
        returnByValue: true,
        awaitPromise: false,
      },
      best.ctx.sessionId,
    );
    const raw = reply.result?.result?.value;
    if (!raw || typeof raw !== "object") {
      return { typed: false, submitted: false, searched: contexts.length };
    }
    const rec = raw as { typed?: unknown; submitted?: unknown; partial?: unknown };
    const inFrame = best.ctx.depth > 0;
    if (inFrame && rec.typed === true) {
      // Never the value, never the full URL (a challenge URL carries tokens) —
      // just that an embedded frame took it, and whose it was.
      console.log(
        `cdp inject landed in an embedded frame (${hostOf(best.ctx.url)}), ${contexts.length} searched`,
      );
    }
    return {
      typed: rec.typed === true,
      submitted: rec.submitted === true,
      ...(rec.partial === true ? { partial: true } : {}),
      searched: contexts.length,
      ...(inFrame ? { inFrame: true } : {}),
    };
  } finally {
    session.close();
  }
}

export { cdpPageUrl } from "../../convex/lib/browserCdp.ts";
