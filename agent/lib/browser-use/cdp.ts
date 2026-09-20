import { z } from "zod";

/**
 * Typing a one-time code into the run's own browser over the Chrome DevTools
 * Protocol, instead of asking the cloud agent to type it.
 *
 * The cloud agent can do it — this is a shortcut, not a repair. What it saves
 * is the round trip: a queued message waits for the agent's next step, and a
 * code that arrives after its run has finished costs a whole new run before
 * anyone touches the keyboard. Bank codes expire in a couple of minutes, so
 * that gap is the difference between a payment that goes through and one the
 * person has to start over. Typing it directly takes about a second and no
 * tokens.
 *
 * Everything here is best effort: when the field cannot be found with
 * confidence the caller still hands the code to the cloud agent, which is
 * what happened before this existed.
 */

const targetSchema = z.object({
  type: z.string().optional(),
  webSocketDebuggerUrl: z.string().optional(),
});

const frameSchema: z.ZodType<{
  childFrames?: unknown[];
  frame?: { id?: string; url?: string };
}> = z.object({
  childFrames: z.array(z.lazy(() => frameSchema)).optional(),
  frame: z.object({ id: z.string().optional(), url: z.string().optional() }),
});

const frameTreeSchema = z.object({ frameTree: frameSchema });

const isolatedWorldSchema = z.object({
  executionContextId: z.number().int(),
});

const attachedTargetSchema = z.object({
  sessionId: z.string().min(1),
  targetInfo: z.object({ type: z.string() }),
});

/** What the injected program reports, in either of its two modes. */
const injectionSchema = z.object({
  ok: z.boolean(),
  partial: z.boolean().optional(),
  score: z.number().optional(),
  submitted: z.boolean().optional(),
  typed: z.boolean().optional(),
});

const resultSchema = z.json();

/** A protocol frame: a reply carries an id, an event carries a method. */
const messageSchema = z.object({
  id: z.number().int().optional(),
  method: z.string().optional(),
  params: z.json().optional(),
  result: z.json().optional(),
});

const evaluationSchema = z.object({
  result: z.object({ value: z.json().optional() }).optional(),
});

export interface OneTimeCodeEntry {
  /** The value landed in an embedded frame rather than the page itself — the
   *  3-D Secure case. */
  readonly inFrame: boolean;
  /** A single one-character box took only the first digit of a longer value,
   *  so the entry is not complete and the cloud agent must still type it. */
  readonly partial: boolean;
  /** How many frame contexts were searched. One means the top document alone. */
  readonly searched: number;
  /** A confirm button was pressed afterwards. Never a pay or order button. */
  readonly submitted: boolean;
  readonly typed: boolean;
}

const nothingTyped: OneTimeCodeEntry = {
  inFrame: false,
  partial: false,
  searched: 0,
  submitted: false,
  typed: false,
};

/** Depth of embedding still worth walking: a 3-D Secure form sits at one, a
 *  processor that wraps the bank's own page puts it at two. Deeper than three
 *  there is nothing but advertising furniture. */
const maxFrameDepth = 3;
/** A page full of ad slots must not turn one code into a hundred round trips. */
const maxContexts = 24;
/** Auto-attach reports existing children through events, so give them a moment
 *  to arrive before walking what came in. */
const attachSettleMs = 300;
const commandTimeoutMs = 15_000;
const connectTimeoutMs = 10_000;

/**
 * What an embedded frame must score before it may take the code away from the
 * page's own document: a naming signal, not merely a focused input.
 *
 * In the page the errand itself opened, a bare focus signal is decent
 * evidence. In a frame that page embedded from somewhere else it is not — it
 * is what an unrelated widget that happens to autofocus looks like, and a
 * one-time code is not something to hand over on a guess. A real 3-D Secure
 * field names itself; one that does not falls back to the cloud agent.
 */
const minFrameScore = 50;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A run of four to eight single-character boxes fed an all-digit value, worth
 *  more than an ordinary field (≤90) and less than a field that says outright
 *  it wants a one-time code. Only used to compare frames: inside one document
 *  the boxes already win. */
const boxesScore = 100;

/** Frames smaller than this hold no real form. A tracking pixel must never be
 *  offered a one-time code, however temptingly its input is named. */
const minFrameWidth = 100;
const minFrameHeight = 40;

/**
 * One program, two modes. `apply: false` only reports how good this frame's
 * best candidate is, so every frame can be ranked before anything is typed
 * anywhere; `apply: true` performs the entry in the frame that won. Keeping it
 * one body keeps the weights, the visibility rules and the never-click list in
 * a single place — two copies would drift the first time one is fixed.
 *
 * It runs as a string inside the page, so it cannot import anything: the
 * scoring below is the only copy, and `scripts/cdp-probe.ts` is what proves it
 * against a real browser.
 */
const injectionProgram = `function (raw, apply) {
  const value = String(raw ?? "");
  const miss = { ok: false, score: 0, typed: false, submitted: false };
  if (!value) return miss;
  if (window.innerWidth < ${String(minFrameWidth)} || window.innerHeight < ${String(minFrameHeight)}) return miss;
  const visible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.disabled || el.readOnly) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  };
  const setValue = (el, next) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: next, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const inputs = Array.from(document.querySelectorAll("input, textarea")).filter((el) => {
    if (!visible(el)) return false;
    if (el instanceof HTMLInputElement) {
      if (["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio", "password"].includes(el.type)) return false;
    }
    return true;
  });
  const score = (el) => {
    const auto = (el.autocomplete || "").toLowerCase();
    const bits = [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.type].filter(Boolean).join(" ").toLowerCase();
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
  // No bare "the only input on the page" escape hatch: a score of zero with no
  // focus signal is not evidence this is the right field.
  const targetOk = Boolean(target && (score(target) > 0 || document.activeElement === target));
  if (!useBoxes && !targetOk) return miss;
  const partial = Boolean(!useBoxes && target instanceof HTMLInputElement && target.maxLength === 1 && value.length > 1);
  if (!apply) return { ok: true, score: useBoxes ? ${String(boxesScore)} : score(target), partial: partial, typed: false, submitted: false };
  if (useBoxes) {
    const chars = value.slice(0, boxes.length).split("");
    boxes.forEach((el, index) => setValue(el, chars[index] ?? ""));
  } else if (partial) {
    setValue(target, value.slice(0, 1));
    return { ok: true, typed: true, submitted: false, partial: true };
  } else {
    setValue(target, value);
  }
  const forbid = /заказать|поехали|оплатить|купить|pay|order/i;
  const allow = /^(войти|подтвердить|продолжить|далее|отправить|verify|continue|submit|confirm|next|sign in|log in)$/i;
  const buttons = Array.from(document.querySelectorAll("button, [role='button'], input[type=submit]"));
  for (const button of buttons) {
    if (!visible(button)) continue;
    const label = (button.innerText || button.value || button.getAttribute("aria-label") || "").trim();
    if (!label || forbid.test(label) || !allow.test(label)) continue;
    button.click();
    return { ok: true, typed: true, submitted: true, partial: false };
  }
  return { ok: true, typed: true, submitted: false, partial: false };
}`;

/** One searchable JavaScript context: a frame, and the session that owns it. */
interface FrameContext {
  readonly contextId: number;
  /** Zero is the page's own main frame; everything deeper is embedded. */
  readonly depth: number;
  readonly sessionId: string | undefined;
  readonly url: string | undefined;
}

/** Every parameter this module sends, and nothing else. */
interface CdpCommand {
  readonly autoAttach?: boolean;
  readonly awaitPromise?: boolean;
  readonly contextId?: number;
  readonly expression?: string;
  readonly flatten?: boolean;
  readonly frameId?: string;
  readonly returnByValue?: boolean;
  readonly waitForDebuggerOnStart?: boolean;
  readonly worldName?: string;
}

/** A command result, still shapeless but no longer `unknown`: each caller runs
 *  the schema for the one command it sent. */
type CdpResult = z.infer<typeof resultSchema>;

/** One command on the wire. */
interface CdpRequest {
  id: number;
  method: string;
  params: CdpCommand;
  sessionId?: string;
}

interface CdpConnection {
  readonly call: (
    method: string,
    parameters: CdpCommand,
    sessionId?: string
  ) => Promise<CdpResult>;
  readonly close: () => void;
  /** Called with the session id of each embedded frame that attaches. */
  readonly onAttached: (listen: (sessionId: string) => void) => void;
}

/**
 * Type a one-time code into the live browser behind `cdpUrl`.
 *
 * The frame walk is the point. Evaluating against the page alone only ever
 * sees the top-level document, and a bank's 3-D Secure challenge is a
 * cross-origin iframe, so without it every bank code failed to find a field.
 * Two mechanisms are needed because a browser has two kinds of embedded frame:
 * one that shares the page's renderer is reached by making an isolated world
 * for its frame id, and one with a renderer of its own answers only on the
 * session `Target.setAutoAttach` hands over.
 *
 * Every frame is scored before anything is typed anywhere, and only the winner
 * is filled, so a page carrying a bank frame and three ad frames cannot get
 * the code sprayed across all four. A password field is never filled, and a
 * pay or order button is never pressed.
 */
export async function typeOneTimeCodeOverCdp(
  cdpUrl: string,
  code: string
): Promise<OneTimeCodeEntry> {
  const value = code.trim();
  if (!value) return nothingTyped;
  const connection = await connect(cdpUrl);
  try {
    const contexts = await collectContexts(connection);
    if (contexts.length === 0) return nothingTyped;
    const scored = await Promise.all(
      contexts.map(async (context) => ({
        context,
        injection: await evaluate(connection, context, value, false),
      }))
    );
    // Strictly greater, walked in collection order, so the top document keeps a
    // tie and an embedded frame only wins by scoring higher on its own.
    let best: (typeof scored)[number] | undefined;
    for (const candidate of scored) {
      if (!candidate.injection?.ok) continue;
      const score = candidate.injection.score ?? 0;
      if (candidate.context.depth > 0 && score < minFrameScore) continue;
      if (!best || score > (best.injection?.score ?? 0)) best = candidate;
    }
    if (!best) return { ...nothingTyped, searched: contexts.length };
    const applied = await evaluate(connection, best.context, value, true);
    return {
      inFrame: best.context.depth > 0,
      partial: applied?.partial === true,
      searched: contexts.length,
      submitted: applied?.submitted === true,
      typed: applied?.typed === true,
    };
  } finally {
    connection.close();
  }
}

async function evaluate(
  connection: CdpConnection,
  context: FrameContext,
  value: string,
  apply: boolean
) {
  const reply = await connection
    .call(
      "Runtime.evaluate",
      {
        awaitPromise: false,
        contextId: context.contextId,
        expression: `(${injectionProgram})(${JSON.stringify(value)}, ${String(apply)})`,
        returnByValue: true,
      },
      context.sessionId
    )
    .catch(() => undefined);
  const parsed = evaluationSchema.safeParse(reply);
  if (!parsed.success) return undefined;
  const injection = injectionSchema.safeParse(parsed.data.result?.value);
  return injection.success ? injection.data : undefined;
}

/** Every context worth searching, top document first. */
async function collectContexts(connection: CdpConnection) {
  const contexts: FrameContext[] = [];
  const attached: string[] = [];
  connection.onAttached((sessionId) => {
    attached.push(sessionId);
  });

  const walk = async (sessionId: string | undefined, depth: number) => {
    if (depth > maxFrameDepth || contexts.length >= maxContexts) return;
    await connection.call("Page.enable", {}, sessionId).catch(() => undefined);
    await connection
      .call(
        "Target.setAutoAttach",
        { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
        sessionId
      )
      .catch(() => undefined);
    const tree = frameTreeSchema.safeParse(
      await connection
        .call("Page.getFrameTree", {}, sessionId)
        .catch(() => undefined)
    );
    if (!tree.success) return;
    const frames = flattenFrames(tree.data.frameTree, 0).filter(
      (frame) => depth + frame.depth <= maxFrameDepth
    );
    // A frame belonging to another renderer is listed here but has no context
    // to make in this one: it arrives on its own session instead, so that
    // failure is expected and silent.
    const worlds = await Promise.all(
      frames.map(async (frame) => ({
        frame,
        world: isolatedWorldSchema.safeParse(
          await connection
            .call(
              "Page.createIsolatedWorld",
              { frameId: frame.id, worldName: "browser-use-code-entry" },
              sessionId
            )
            .catch(() => undefined)
        ),
      }))
    );
    for (const { frame, world } of worlds) {
      if (!world.success || contexts.length >= maxContexts) continue;
      contexts.push({
        contextId: world.data.executionContextId,
        depth: depth + frame.depth,
        sessionId,
        url: frame.url,
      });
    }
  };

  await walk(undefined, 0);
  // Children announce themselves asynchronously, and walking them is what turns
  // a cross-process 3-D Secure frame from invisible into searchable. Recursion
  // rather than a loop keeps each round one awaited step.
  const walkAttached = async (cursor: number, round: number): Promise<void> => {
    if (round >= maxFrameDepth || contexts.length >= maxContexts) return;
    await sleep(attachSettleMs);
    const batch = attached.slice(cursor);
    if (batch.length === 0) return;
    await Promise.all(batch.map((sessionId) => walk(sessionId, round + 1)));
    await walkAttached(cursor + batch.length, round + 1);
  };
  await walkAttached(0, 0);
  return contexts;
}

/** Depth is counted per frame, not per session: a same-renderer iframe shares
 *  its parent's session and would otherwise read as the page itself. */
function flattenFrames(
  node: z.infer<typeof frameSchema>,
  depth: number
): { depth: number; id: string; url: string | undefined }[] {
  const id = node.frame?.id;
  const here = id ? [{ depth, id, url: node.frame?.url }] : [];
  const children = node.childFrames ?? [];
  return [
    ...here,
    ...children.flatMap((child) =>
      flattenFrames(frameSchema.parse(child), depth + 1)
    ),
  ];
}

/**
 * The debugger endpoint is handed over as a WebSocket URL for the browser, but
 * a code goes into a page, so the page's own socket is what this opens. The
 * list lives on the HTTP form of the same endpoint.
 */
async function pageSocketUrl(cdpUrl: string) {
  const httpBase = cdpUrl
    .trim()
    .replace(/\/$/u, "")
    .replace(/^ws:/iu, "http:")
    .replace(/^wss:/iu, "https:");
  const response = await fetch(`${httpBase}/json`, {
    signal: AbortSignal.timeout(connectTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `The browser's target list answered ${String(response.status)}.`
    );
  }
  const targets = z.array(targetSchema).parse(await response.json());
  const page = targets.find((target) => target.type === "page") ?? targets[0];
  const socketUrl = page?.webSocketDebuggerUrl?.trim();
  if (!socketUrl) throw new Error("The browser exposes no page to type into.");
  return socketUrl;
}

async function connect(cdpUrl: string): Promise<CdpConnection> {
  const socket = new WebSocket(await pageSocketUrl(cdpUrl));
  const pending = new Map<number, (reply: CdpResult) => void>();
  const attachedListeners: ((sessionId: string) => void)[] = [];
  let nextId = 1;

  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("The browser's debugger did not accept a connection."));
    }, connectTimeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("The browser's debugger connection failed."));
    });
  });

  socket.addEventListener("message", (event) => {
    const message = messageSchema.safeParse(safeJson(String(event.data)));
    if (!message.success) return;
    if (message.data.id !== undefined) {
      const waiting = pending.get(message.data.id);
      if (!waiting) return;
      pending.delete(message.data.id);
      waiting(message.data.result ?? {});
      return;
    }
    // An event rather than a reply. With a flattened auto-attach this is how a
    // cross-process frame announces the session its renderer answers on.
    if (message.data.method !== "Target.attachedToTarget") return;
    const attached = attachedTargetSchema.safeParse(message.data.params);
    if (!attached.success) return;
    const { type } = attached.data.targetInfo;
    // Only embedded documents: a worker has no DOM to type into.
    if (type !== "iframe" && type !== "page") return;
    for (const listen of attachedListeners) listen(attached.data.sessionId);
  });

  await opened;

  return {
    call: async (method, parameters, sessionId) => {
      const id = nextId;
      nextId += 1;
      return await new Promise<CdpResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`The browser did not answer ${method}.`));
        }, commandTimeoutMs);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
        const frame: CdpRequest = { id, method, params: parameters };
        if (sessionId !== undefined) frame.sessionId = sessionId;
        socket.send(JSON.stringify(frame));
      });
    },
    close: () => {
      socket.close();
    },
    onAttached: (listen) => {
      attachedListeners.push(listen);
    },
  };
}

function safeJson(text: string) {
  try {
    // SAFETY: `JSON.parse` hands back `any`. Widening it to `unknown` here is
    // what forces the schema above to establish the shape before any field of
    // it is read.
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
