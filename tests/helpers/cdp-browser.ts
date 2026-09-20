import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
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
      contextId: z.number().int().optional(),
      expression: z.string().optional(),
      flatten: z.boolean().optional(),
      frameId: z.string().optional(),
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

export interface CdpBrowserFixture {
  /** What the injected program answers, per execution context id. */
  readonly injections: Readonly<Record<number, Injection>>;
  /** Keyed by session id; the page's own session is the empty string. */
  readonly sessions: Readonly<Record<string, FrameFixture>>;
}

export interface FakeCdpBrowser {
  /** Every `Runtime.evaluate` that actually typed, in the order it ran. */
  readonly applied: readonly number[];
  readonly calls: readonly CdpCall[];
  readonly close: () => Promise<void>;
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
    events.push(
      JSON.stringify({ id, result: result(method, params, session) })
    );
    return events;
  }

  function result(
    method: string,
    params: CdpCall["params"],
    session: FrameFixture | undefined
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
      return { executionContextId: next };
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
    url: `http://127.0.0.1:${String(port)}`,
  };
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
