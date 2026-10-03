import { z } from "zod";

/**
 * The way out of the cloud session drops about one request in twenty to
 * brobro.tech: `fetch failed` on a connect timeout, on a tunnel the proxy
 * could not open, or on a reset (`docs/dev-notes.md`, «Vercel»). The driver
 * sends a request again only when that cannot change the case:
 *
 * - one that provably never left — the TCP connect, the TLS handshake or the
 *   proxy tunnel failed before a byte of it was sent — whatever its method;
 * - a read (a GET, the conversation's stream from the driver's cursor) after
 *   any dropped connection.
 *
 * A POST cut off once the connection was up may have reached Bro: sent
 * again, a message would arrive twice and change the case. It is never
 * repeated; the error says so, and the case fails as before.
 */

/** The waits before each repeat: four repeats, 30 s in all. */
const retryDelaysMs = [2000, 4000, 8000, 16_000] as const;

/** Failures before the connection was up: nothing of the request was sent. */
const unsentCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  // undici's connect timeout covers the TCP connect and the TLS handshake.
  "UND_ERR_CONNECT_TIMEOUT",
]);
const unsentSyscalls = new Set(["connect", "getaddrinfo"]);
/**
 * A socket closed during the TLS handshake (code `ECONNRESET`), and the
 * session's proxy failing to reach the host, which undici reports as an
 * aborted request.
 */
const unsentMessage =
  /^(?:Client network socket disconnected before secure TLS connection was established|Proxy response \(50[234]\) !== 200 when HTTP Tunneling)/u;

/** A connection dropped after it was up: the request may have been sent. */
const droppedCodes = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
/** What undici's `fetch` throws for any network failure, and for a cut body. */
const fetchFailure = /^(?:fetch failed|terminated)$/u;

/** Node's string `code`; a DOMException's numeric one is something else. */
const errnoSchema = z.object({
  code: z.string().optional().catch(undefined),
  syscall: z.string().optional().catch(undefined),
});

/** The error and the causes under it, outermost first. */
function causeChain(error: Error): Error[] {
  const chain = [error];
  for (
    let link = error.cause;
    link instanceof Error && chain.length < 8;
    link = link.cause
  ) {
    chain.push(link);
  }
  return chain;
}

/** Whether this link of the chain says the connection never came up. */
function neverConnected(link: Error) {
  const { code, syscall } = errnoSchema.parse(link);
  return (
    (code !== undefined && unsentCodes.has(code)) ||
    (syscall !== undefined && unsentSyscalls.has(syscall)) ||
    unsentMessage.test(link.message)
  );
}

function connectionDropped(link: Error) {
  const { code } = errnoSchema.parse(link);
  return code !== undefined && droppedCodes.has(code);
}

/** Whether the request never left, may have, or the failure is not the network's. */
function lostRequest(error: Error) {
  const chain = causeChain(error);
  if (chain.some((link) => neverConnected(link))) return "unsent";
  if (
    (error instanceof TypeError && fetchFailure.test(error.message)) ||
    chain.some((link) => connectionDropped(link))
  ) {
    return "uncertain";
  }
  return undefined;
}

/** The innermost cause, which names what happened: `UND_ERR_SOCKET: other side closed`. */
function lossDetail(error: Error) {
  const innermost = causeChain(error).at(-1) ?? error;
  const { code } = errnoSchema.parse(innermost);
  return `${code ?? innermost.name}: ${innermost.message}`.slice(0, 200);
}

/**
 * Waits `ms`; an abort ends the wait and throws its reason. The global
 * `setTimeout`, which a test's fake clock also moves.
 */
async function pause(ms: number, signal: AbortSignal | undefined) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
  signal?.throwIfAborted();
}

/** A POST cut off after it left: it may have reached the server. */
export class UncertainDeliveryError extends Error {
  /** The request, as `RetryRequest.label` named it. */
  readonly label: string;

  constructor(label: string, error: Error) {
    super(
      `${label}: соединение оборвалось, когда запрос уже ушёл (${lossDetail(error)}), — он мог дойти, и драйвер его не повторяет`,
      { cause: error }
    );
    this.name = "UncertainDeliveryError";
    this.label = label;
  }
}

export interface RetryRequest {
  /** A read, safe to send again even if it reached the server. */
  readonly idempotent: boolean;
  /** What is sent, for the log: «сообщение», «GET /api/auth/get-session». */
  readonly label: string;
  /** Where a repeat is noted; the console by default. */
  readonly log?: (line: string) => Promise<void> | void;
  /** Stops the waits between repeats; an aborted request is not repeated. */
  readonly signal?: AbortSignal;
}

/**
 * Runs `send` — one request and the reading of its answer — and runs it
 * again, after 2, 4, 8 and 16 s, while it fails on the way in a way that is
 * safe to repeat (see above). Any other failure, and the last one, is thrown
 * as it came.
 */
export async function withRetry<T>(
  request: RetryRequest,
  send: () => Promise<T>
): Promise<T> {
  const log =
    request.log ??
    ((line: string) => {
      console.warn(line);
    });
  for (let repeat = 0; ; repeat += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a repeat waits for the attempt before it
      return await send();
    } catch (error) {
      if (!(error instanceof Error) || request.signal?.aborted) throw error;
      const loss = lostRequest(error);
      if (loss === undefined) throw error;
      if (loss === "uncertain" && !request.idempotent) {
        throw new UncertainDeliveryError(request.label, error);
      }
      const delayMs = retryDelaysMs[repeat];
      if (delayMs === undefined) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the last line before giving up
        await log(
          `${request.label}: сбой сети (${lossDetail(error)}) и после ${String(retryDelaysMs.length)} повторов — драйвер сдаётся`
        );
        throw error;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- the log keeps the order of the attempts
      await log(
        `${request.label}: сбой сети (${lossDetail(error)}) — повтор через ${String(delayMs / 1000)} с (${String(repeat + 1)}/${String(retryDelaysMs.length)})`
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- the backoff before the next attempt
      await pause(delayMs, request.signal);
    }
  }
}
