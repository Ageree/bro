import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

// The part of SIP (RFC 3261) one outbound call over TCP needs: messages, digest auth (RFC 2617/7616 MD5),
// one connection that matches responses to their request by branch and hands requests from the far side
// to the caller.

export interface SipMessage {
  startLine: string;
  headers: Map<string, string[]>;
  body: string;
}

// Compact header forms (RFC 3261 §7.3.3), read under their full names.
const compact = new Map([
  ["v", "via"],
  ["f", "from"],
  ["t", "to"],
  ["i", "call-id"],
  ["m", "contact"],
  ["l", "content-length"],
  ["c", "content-type"],
]);

export function header(message: SipMessage, name: string) {
  return message.headers.get(name.toLowerCase())?.[0];
}

export function status(message: SipMessage) {
  const match = /^SIP\/2\.0 (\d{3})/u.exec(message.startLine);
  return match ? Number(match[1]) : null;
}

function parseHead(head: string) {
  const [startLine = "", ...rest] = head.split("\r\n");
  const headers = new Map<string, string[]>();
  for (const line of rest) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const raw = line.slice(0, colon).trim().toLowerCase();
    const name = compact.get(raw) ?? raw;
    headers.set(name, [
      ...(headers.get(name) ?? []),
      line.slice(colon + 1).trim(),
    ]);
  }
  return { startLine, headers };
}

/** Whole messages off the front of a TCP stream; what remains waits for the next chunk. */
export function takeMessages(buffer: Buffer) {
  const messages: SipMessage[] = [];
  let rest = buffer;
  for (;;) {
    // Keep-alive CRLFs between messages (RFC 5626).
    while (rest.length >= 2 && rest[0] === 0x0d && rest[1] === 0x0a)
      rest = rest.subarray(2);
    const end = rest.indexOf("\r\n\r\n");
    if (end === -1) break;
    const { startLine, headers } = parseHead(
      rest.subarray(0, end).toString("utf8")
    );
    const length = Number(headers.get("content-length")?.[0] ?? "0");
    if (rest.length < end + 4 + length) break;
    messages.push({
      startLine,
      headers,
      body: rest.subarray(end + 4, end + 4 + length).toString("utf8"),
    });
    rest = rest.subarray(end + 4 + length);
  }
  return { messages, rest };
}

export function render(
  startLine: string,
  headers: readonly (readonly [string, string])[],
  body = ""
) {
  const lines = [
    startLine,
    ...headers.map(([name, value]) => `${name}: ${value}`),
  ];
  lines.push(`Content-Length: ${String(Buffer.byteLength(body))}`, "", body);
  return lines.join("\r\n");
}

export function token(bytes = 8) {
  return randomBytes(bytes).toString("hex");
}

function param(challenge: string, name: string) {
  const match = new RegExp(`${name}=(?:"([^"]*)"|([^,\\s]+))`, "iu").exec(
    challenge
  );
  return match ? (match[1] ?? match[2]) : undefined;
}

const md5 = (value: string) => createHash("md5").update(value).digest("hex");

/** The Authorization (or Proxy-Authorization) value answering a Digest challenge. */
export function digest(input: {
  challenge: string;
  method: string;
  uri: string;
  username: string;
  password: string;
  cnonce?: string;
  nc?: string;
}) {
  const realm = param(input.challenge, "realm") ?? "";
  const nonce = param(input.challenge, "nonce") ?? "";
  const opaque = param(input.challenge, "opaque");
  const algorithm = param(input.challenge, "algorithm");
  if (algorithm && algorithm.toUpperCase() !== "MD5")
    throw new Error(`SIP digest algorithm ${algorithm} is not supported.`);
  const qop = param(input.challenge, "qop")
    ?.split(",")
    .map((value) => value.trim())
    .find((value) => value === "auth");
  const ha1 = md5(`${input.username}:${realm}:${input.password}`);
  const ha2 = md5(`${input.method}:${input.uri}`);
  const cnonce = input.cnonce ?? token();
  const nc = input.nc ?? "00000001";
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${input.username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${input.uri}"`,
    `response="${response}"`,
    "algorithm=MD5",
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opaque !== undefined) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

function branchOf(message: SipMessage) {
  return /;branch=([^;,\s]+)/u.exec(header(message, "via") ?? "")?.[1];
}

/** The tag of a From or To value. */
export function tagOf(value: string | undefined) {
  return /;tag=([^;,\s]+)/u.exec(value ?? "")?.[1];
}

/** The URI inside <…> of a Contact or Record-Route entry. */
export function uriOf(value: string) {
  return /<([^>]+)>/u.exec(value)?.[1] ?? (value.split(";")[0] ?? value).trim();
}

/**
 * One TCP connection to the carrier's proxy. `request` resolves with the final response (and reports each
 * provisional one); requests from the far side go to `onRequest`. Every message is logged without its
 * Authorization lines.
 */
export async function openSip(options: {
  host: string;
  port: number;
  log: (line: string) => void;
  onRequest: (
    message: SipMessage,
    reply: (
      code: number,
      reason: string,
      extra?: [string, string][],
      body?: string
    ) => void
  ) => void;
}) {
  const socket: Socket = await new Promise((resolve, reject) => {
    const opened = connect({ host: options.host, port: options.port }, () => {
      resolve(opened);
    });
    opened.once("error", reject);
    opened.setTimeout(30_000, () =>
      opened.destroy(new Error("SIP connection timed out."))
    );
  });
  socket.setTimeout(0);
  socket.on("error", (error) => {
    options.log(`SIP connection: ${error.message}`);
  });
  socket.setKeepAlive(true, 15_000);
  const waiting = new Map<
    string,
    {
      onProvisional: (message: SipMessage) => void;
      resolve: (message: SipMessage) => void;
    }
  >();
  let buffer: Buffer = Buffer.alloc(0);
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      resolve();
    });
  });
  const logMessage = (direction: string, text: string) => {
    options.log(
      `${direction} ${text
        .split("\r\n")
        .filter((line) => !/^(proxy-)?authorization:/iu.test(line))
        .join(" | ")
        .slice(0, 900)}`
    );
  };
  const write = (text: string) => {
    logMessage(">>", text);
    socket.write(text);
  };
  socket.on("data", (chunk: Buffer) => {
    const taken = takeMessages(Buffer.concat([buffer, chunk]));
    buffer = taken.rest;
    for (const message of taken.messages) {
      logMessage(
        "<<",
        `${message.startLine} | ${[...message.headers].map(([k, v]) => `${k}: ${v.join(", ")}`).join(" | ")}`
      );
      const code = status(message);
      if (code === null) {
        options.onRequest(message, (reply, reason, extra = [], body = "") => {
          const copied = ["via", "from", "to", "call-id", "cseq"].flatMap(
            (name) =>
              (message.headers.get(name) ?? []).map(
                (value): [string, string] => [
                  name.replace(/^./u, (c) => c.toUpperCase()),
                  value,
                ]
              )
          );
          write(
            render(
              `SIP/2.0 ${String(reply)} ${reason}`,
              [...copied, ...extra],
              body
            )
          );
        });
        continue;
      }
      const branch = branchOf(message);
      const entry = branch ? waiting.get(branch) : undefined;
      if (!entry) continue;
      if (code < 200) entry.onProvisional(message);
      else {
        waiting.delete(branch ?? "");
        entry.resolve(message);
      }
    }
  });
  return {
    localAddress: socket.localAddress ?? "0.0.0.0",
    localPort: socket.localPort ?? 0,
    closed,
    /** Sends a request whose Via carries `branch`; resolves with its final response. */
    request(
      text: string,
      branch: string,
      onProvisional: (message: SipMessage) => void = () => undefined
    ) {
      return new Promise<SipMessage>((resolve) => {
        waiting.set(branch, { onProvisional, resolve });
        write(text);
      });
    },
    /** A message no response answers (ACK). */
    send(text: string) {
      write(text);
    },
    close() {
      socket.end();
    },
  };
}
