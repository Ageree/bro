import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { createContext, runInContext, type Context } from "node:vm";
import { z } from "zod";

/**
 * A browser's debugger endpoint, faked well enough to drive the frame walk.
 *
 * Which field on a page wins a one-time code is decided by a program that runs
 * inside a browser, and `scripts/cdp-probe.ts` is what proves that against a
 * real one. What this stands in for is everything around it: the page socket,
 * the frame tree, the sessions an embedded frame answers on, and above all the
 * rule that every context is scored before any of them is typed into. Those are
 * protocol decisions, so they can be checked against a scripted protocol
 * without a browser, which is what lets them run in CI.
 *
 * A context given a `documents` page runs the real injected program against
 * a small stand-in DOM instead of a scripted answer: just the fields, buttons,
 * open shadow roots and focus the program reads, so its rules — shadow roots,
 * never a password field, boxes against a whole-code field — run in CI too.
 *
 * The WebSocket server is written out here because the repository has no server
 * implementation to depend on and a test is a poor reason to add one. It speaks
 * the subset of RFC 6455 these tests need: single-frame text messages and a
 * close frame, nothing fragmented.
 */

const commandSchema = z.object({
  id: z.number().int(),
  method: z.string(),
  params: z
    .object({
      arguments: z.array(z.object({ value: z.json() })).optional(),
      awaitPromise: z.boolean().optional(),
      contextId: z.number().int().optional(),
      errorReason: z.string().optional(),
      expression: z.string().optional(),
      flatten: z.boolean().optional(),
      format: z.string().optional(),
      frameId: z.string().optional(),
      functionDeclaration: z.string().optional(),
      objectId: z.string().optional(),
      requestId: z.string().optional(),
      returnByValue: z.boolean().optional(),
      text: z.string().optional(),
      url: z.string().optional(),
      urls: z.array(z.string()).optional(),
    })
    .default({}),
  sessionId: z.string().optional(),
});

const addressSchema = z.object({ port: z.number().int() });

type CdpCall = z.infer<typeof commandSchema>;

interface FrameFixture {
  /** Embedded documents that attach on their own session when this one does. */
  readonly attaches?: readonly string[];
  /** Frame ids this session's tree reports, parents before children. */
  readonly frames: readonly { readonly depth: number; readonly id: string }[];
}

interface Injection {
  readonly ok: boolean;
  readonly partial?: boolean;
  readonly score?: number;
}

/** One element of a stand-in page, in document order. */
export interface FakeElementSpec {
  /** `name`, `type`, `autocomplete`, `maxlength`, `role`, `aria-label`… */
  readonly attributes?: Readonly<Record<string, string>>;
  readonly focused?: boolean;
  readonly hidden?: boolean;
  /** What sits inside the element's open shadow root: a web component. */
  readonly shadow?: readonly FakeElementSpec[];
  readonly tag: string;
  /** A button's label. */
  readonly text?: string;
  /** Takes no focus, like a field whose page keeps the focus elsewhere. */
  readonly unfocusable?: boolean;
  readonly value?: string;
}

/** Where a stand-in field's value came from. */
type FieldWrite = "insertText" | "setter";

interface FakeFieldState {
  readonly name: string;
  readonly value: string;
  readonly writes: readonly FieldWrite[];
}

export interface CdpBrowserFixture {
  /**
   * Stand-in pages the real injected program runs against, per execution
   * context id. A context listed here ignores `injections`.
   */
  readonly documents?: Readonly<Record<number, readonly FakeElementSpec[]>>;
  /** What the injected program answers, per execution context id. */
  readonly injections: Readonly<Record<number, Injection>>;
  /** Where a page opened with `Page.navigate` ends up, and what it shows. */
  readonly page?: {
    /** What a function called in the page (`Runtime.callFunctionOn`) returns. */
    readonly answer?: z.infer<ReturnType<typeof z.json>>;
    readonly password?: boolean;
    /**
     * Documents the page asks for after `Page.navigate` — a redirect, an
     * embedded frame — each paused for the client once `Fetch.enable` is on.
     * A request without a frame comes from the page itself.
     */
    readonly requests?: readonly {
      readonly frame?: string;
      readonly url: string;
    }[];
    readonly url: string;
  };
  /** The base64 image `Page.captureScreenshot` answers with. */
  readonly screenshot?: string;
  /** Keyed by session id; the page's own session is the empty string. */
  readonly sessions: Readonly<Record<string, FrameFixture>>;
}

export interface FakeCdpBrowser {
  /** Every `Runtime.evaluate` that actually typed, in the order it ran. */
  readonly applied: readonly number[];
  readonly calls: readonly CdpCall[];
  readonly close: () => Promise<void>;
  /** A stand-in page's buttons pressed and fields, shadow roots included. */
  readonly page: (contextId: number) => {
    readonly clicked: readonly string[];
    readonly fields: readonly FakeFieldState[];
  };
  readonly url: string;
}

interface FrameNode {
  readonly childFrames: readonly FrameNode[];
  readonly frame: { readonly id: string; readonly url: string };
}

interface FrameBuild {
  readonly next: number;
  readonly node: FrameNode;
}

interface ReadFrame {
  readonly opcode: number;
  readonly payload: string;
  readonly rest: Buffer;
}

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export async function startFakeCdpBrowser(
  fixture: CdpBrowserFixture
): Promise<FakeCdpBrowser> {
  const calls: CdpCall[] = [];
  const applied: number[] = [];
  // One context id per frame, handed out as frames are first seen, so a test
  // can address the third frame's field as context three.
  const contextIds = new Map<string, number>();
  /** The session each context was made on, the page's own being "". */
  const contextSessions = new Map<number, string>();
  let fetchEnabled = false;
  let focusClock = 0;
  const pages = new Map(
    Object.entries(fixture.documents ?? {}).map(([contextId, specs]) => {
      const page = new FakePage(specs, () => {
        focusClock += 1;
        return focusClock;
      });
      return [Number(contextId), { page, realm: pageRealm(page) }] as const;
    })
  );

  const server = createServer((request, response) => {
    if (!request.url?.startsWith("/json")) {
      response.writeHead(404).end();
      return;
    }
    const { port } = addressSchema.parse(server.address());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          type: "page",
          url: "https://shop.test/checkout",
          webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/page/1`,
        },
      ])
    );
  });

  server.on("upgrade", (request, socket: Duplex, head: Buffer) => {
    const key = request.headers["sec-websocket-key"];
    if (key === undefined) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${Array.isArray(key) ? key.join("") : key}${websocketGuid}`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n")
    );
    let buffered: Buffer = head;
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const frame = readFrame(buffered);
        if (!frame) return;
        buffered = frame.rest;
        // A close frame, and the only control frame these tests produce.
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        for (const reply of handle(frame.payload))
          socket.write(writeFrame(reply));
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
  });

  function handle(text: string): string[] {
    const command = commandSchema.safeParse(parseJson(text));
    if (!command.success) return [];
    const { id, method, params, sessionId } = command.data;
    calls.push(command.data);
    const session = fixture.sessions[sessionId ?? ""];
    const events: string[] = [];

    if (method === "Target.setAutoAttach") {
      for (const attached of session?.attaches ?? []) {
        events.push(
          JSON.stringify({
            method: "Target.attachedToTarget",
            params: { sessionId: attached, targetInfo: { type: "iframe" } },
          })
        );
      }
    }
    if (method === "Fetch.enable") fetchEnabled = true;
    events.push(
      JSON.stringify({
        id,
        result: result(method, params, session, sessionId ?? ""),
      })
    );
    if (method === "Page.navigate" && fetchEnabled) {
      const main = fixture.sessions[""]?.frames[0]?.id ?? "";
      const documents = [
        { url: params.url ?? "" },
        ...(fixture.page?.requests ?? []),
      ];
      for (const [index, document] of documents.entries()) {
        events.push(
          JSON.stringify({
            method: "Fetch.requestPaused",
            params: {
              frameId: document.frame ?? main,
              request: { url: document.url },
              requestId: `request-${String(index + 1)}`,
            },
          })
        );
      }
    }
    return events;
  }

  function result(
    method: string,
    params: CdpCall["params"],
    session: FrameFixture | undefined,
    sessionId: string
  ) {
    if (method === "Page.getFrameTree") {
      return { frameTree: frameTree(session?.frames ?? []) };
    }
    if (method === "Page.createIsolatedWorld") {
      const frameId = params.frameId ?? "";
      const existing = contextIds.get(frameId);
      if (existing !== undefined) return { executionContextId: existing };
      const next = contextIds.size + 1;
      contextIds.set(frameId, next);
      contextSessions.set(next, sessionId);
      return { executionContextId: next };
    }
    if (method === "Page.captureScreenshot") {
      return { data: fixture.screenshot ?? "" };
    }
    if (
      method === "Runtime.evaluate" &&
      params.expression?.includes("document.readyState") === true
    ) {
      return {
        result: {
          value: {
            password: fixture.page?.password ?? false,
            readyState: "complete",
            url: fixture.page?.url ?? "about:blank",
          },
        },
      };
    }
    if (method === "Runtime.evaluate" && params.expression === "globalThis") {
      return { result: { objectId: "global-1" } };
    }
    if (method === "Runtime.callFunctionOn") {
      return { result: { value: fixture.page?.answer ?? null } };
    }
    if (method === "Input.insertText") {
      // Typed text goes to the field focused last on the session it was sent
      // on, as a page's focused frame receives it.
      const focusedPages = [...pages]
        .filter(
          ([contextId, { page }]) =>
            contextSessions.get(contextId) === sessionId &&
            page.focused !== null
        )
        .map(([, { page }]) => page)
        .toSorted((a, b) => b.focusedAt - a.focusedAt);
      const field = focusedPages[0]?.focused;
      if (field instanceof FakeField) field.insert(params.text ?? "");
      return {};
    }
    const standIn = pages.get(params.contextId ?? 0);
    if (method === "Runtime.evaluate" && standIn !== undefined) {
      if (params.expression?.endsWith(", true)") === true) {
        applied.push(params.contextId ?? 0);
      }
      try {
        return {
          result: {
            value: z
              .json()
              .parse(runInContext(params.expression ?? "", standIn.realm)),
          },
        };
      } catch (error) {
        return {
          exceptionDetails: { text: String(error) },
          result: { type: "undefined" },
        };
      }
    }
    if (method === "Runtime.evaluate") {
      const contextId = params.contextId ?? 0;
      const injection = fixture.injections[contextId] ?? { ok: false };
      // The injected call's second argument is its apply flag.
      const applying = params.expression?.endsWith(", true)") === true;
      if (applying) applied.push(contextId);
      return {
        result: {
          value: {
            ok: injection.ok,
            partial: injection.partial ?? false,
            score: applying ? undefined : (injection.score ?? 0),
            submitted: applying && injection.ok,
            typed: applying && injection.ok,
          },
        },
      };
    }
    return {};
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const { port } = addressSchema.parse(server.address());

  return {
    applied,
    calls,
    close: () => closeServer(server),
    page: (contextId) => {
      const page = pages.get(contextId)?.page;
      return {
        clicked: [...(page?.clicked ?? [])],
        fields: page === undefined ? [] : fieldStates(page.document),
      };
    },
    url: `http://127.0.0.1:${String(port)}`,
  };
}

/** The one selector shape the injected program uses: a tag, an attribute
 *  test, or both, as in `input[type=submit]` and `[role='button']`. */
const selectorPattern =
  /^(?<tag>[a-z-]*)(?:\[(?<attribute>[a-z-]+)=['"]?(?<expected>[\w-]+)['"]?\])?$/u;

/** A page the injected program runs against: its focus, and what was pressed. */
class FakePage {
  readonly clicked: string[] = [];
  readonly document: FakeRoot;
  focused: FakeElement | null = null;
  focusedAt = 0;
  readonly #tick: () => number;

  constructor(specs: readonly FakeElementSpec[], tick: () => number) {
    this.#tick = tick;
    this.document = new FakeRoot(this, null, specs);
  }

  focus(element: FakeElement) {
    this.focused = element;
    this.focusedAt = this.#tick();
  }
}

/** The document, or an element's open shadow root. */
class FakeRoot {
  readonly elements: readonly FakeElement[];
  readonly host: FakeElement | null;
  readonly page: FakePage;

  constructor(
    page: FakePage,
    host: FakeElement | null,
    specs: readonly FakeElementSpec[]
  ) {
    this.page = page;
    this.host = host;
    this.elements = specs.map((spec) =>
      spec.tag === "input"
        ? new FakeInput(spec, this)
        : spec.tag === "textarea"
          ? new FakeTextArea(spec, this)
          : new FakeElement(spec, this)
    );
  }

  /** As a browser has it: the focused element itself, or the shadow host in
   *  this root that contains it. */
  get activeElement() {
    let element = this.page.focused;
    while (element !== null && element.root !== this) {
      element = element.root.host;
    }
    return element;
  }

  querySelectorAll(selector: string) {
    const parts = selector.split(",").map((part) => part.trim());
    return this.elements.filter((element) =>
      parts.some((part) => element.matches(part))
    );
  }
}

class FakeElement {
  readonly isConnected = true;
  readonly root: FakeRoot;
  readonly shadowRoot: FakeRoot | null;
  readonly spec: FakeElementSpec;

  constructor(spec: FakeElementSpec, root: FakeRoot) {
    this.spec = spec;
    this.root = root;
    this.shadowRoot =
      spec.shadow === undefined
        ? null
        : new FakeRoot(root.page, this, spec.shadow);
    if (spec.focused === true) root.page.focus(this);
  }

  get disabled() {
    return this.getAttribute("disabled") !== null;
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  get innerText() {
    return this.spec.text ?? "";
  }

  get name() {
    return this.getAttribute("name") ?? "";
  }

  get placeholder() {
    return this.getAttribute("placeholder") ?? "";
  }

  get readOnly() {
    return this.getAttribute("readonly") !== null;
  }

  get type() {
    return (
      this.getAttribute("type") ??
      (this.spec.tag === "input" ? "text" : this.spec.tag)
    );
  }

  click() {
    this.root.page.clicked.push(this.innerText);
  }

  dispatchEvent() {
    return true;
  }

  focus() {
    if (this.spec.unfocusable !== true) this.root.page.focus(this);
  }

  getAttribute(name: string) {
    return this.spec.attributes?.[name] ?? null;
  }

  getClientRects() {
    return this.spec.hidden === true ? [] : [{ height: 32, width: 240 }];
  }

  matches(part: string) {
    if (part === "*") return true;
    const groups = selectorPattern.exec(part)?.groups;
    if (groups === undefined) {
      throw new Error(`The stand-in DOM does not read the selector ${part}.`);
    }
    const { attribute, expected, tag } = groups;
    return (
      (!tag || tag === this.spec.tag) &&
      (!attribute || this.getAttribute(attribute) === expected)
    );
  }
}

class FakeField extends FakeElement {
  selected = false;
  readonly writes: FieldWrite[] = [];
  #value: string;

  constructor(spec: FakeElementSpec, root: FakeRoot) {
    super(spec, root);
    this.#value = spec.value ?? "";
  }

  get autocomplete() {
    return this.getAttribute("autocomplete") ?? "";
  }

  get maxLength() {
    const limit = this.getAttribute("maxlength");
    return limit === null ? -1 : Number(limit);
  }

  get value() {
    return this.#value;
  }

  set value(next: string) {
    this.#value = next;
    this.selected = false;
    this.writes.push("setter");
  }

  /** Text typed into the focused field, as `Input.insertText` delivers it:
   *  over the selection, and no longer than the field allows. */
  insert(text: string) {
    const next = this.selected ? text : `${this.#value}${text}`;
    this.#value = this.maxLength < 0 ? next : next.slice(0, this.maxLength);
    this.selected = false;
    this.writes.push("insertText");
  }

  select() {
    this.selected = true;
  }
}

class FakeInput extends FakeField {}

class FakeTextArea extends FakeField {}

class FakeEvent {
  readonly type: string;

  constructor(type: string) {
    this.type = type;
  }
}

/** The globals the injected program reads, and nothing else. Its own
 *  globals persist between evaluations, as an isolated world's do. */
function pageRealm(page: FakePage): Context {
  return createContext({
    Event: FakeEvent,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    InputEvent: FakeEvent,
    document: page.document,
    getComputedStyle: (element: FakeElement) => ({
      display: element.spec.hidden === true ? "none" : "block",
      visibility: "visible",
    }),
    window: { innerHeight: 800, innerWidth: 1280 },
  });
}

/** Every field of a stand-in page, shadow roots included, in document order. */
function fieldStates(root: FakeRoot): FakeFieldState[] {
  return root.elements.flatMap((element) => [
    ...(element instanceof FakeField
      ? [
          {
            name: element.name || element.autocomplete || element.spec.tag,
            value: element.value,
            writes: [...element.writes],
          },
        ]
      : []),
    ...(element.shadowRoot === null ? [] : fieldStates(element.shadowRoot)),
  ]);
}

/** Parents before children, so a fixture reads like the page's own nesting. */
function frameTree(
  frames: readonly { readonly depth: number; readonly id: string }[]
): FrameNode {
  const build = (index: number): FrameBuild => {
    const frame = frames[index];
    if (!frame) {
      return {
        next: index,
        node: { childFrames: [], frame: { id: "", url: "" } },
      };
    }
    const children: FrameNode[] = [];
    let cursor = index + 1;
    for (;;) {
      const child = frames[cursor];
      if (!child || child.depth <= frame.depth) break;
      const built = build(cursor);
      children.push(built.node);
      cursor = built.next;
    }
    return {
      next: cursor,
      node: {
        childFrames: children,
        frame: { id: frame.id, url: `https://${frame.id}.test/` },
      },
    };
  };
  return build(0).node;
}

function parseJson(text: string) {
  try {
    // SAFETY: `JSON.parse` hands back `any`, and the schema above is what turns
    // it into a command before any field is read.
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

function readFrame(buffer: Buffer): ReadFrame | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = buffer.subarray(offset, offset + maskLength);
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
  }
  return {
    opcode: first & 0x0f,
    payload: payload.toString("utf8"),
    rest: buffer.subarray(offset + length),
  };
}

function writeFrame(text: string) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}
