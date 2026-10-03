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
 * repeated; the error says so, and the case fails as before. Neither is a
 * request the proxy or TLS turned away for good (a 403 to the tunnel, a
 * certificate that does not verify): it never left, but a repeat gets the
 * same answer.
 */

/** The waits before each repeat: four repeats, 30 s in all. */
const retryDelaysMs = [2000, 4000, 8000, 16_000] as const;

/** A TCP connect that failed: only with `syscall: "connect"`. */
const connectCodes = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);
/** A name that did not resolve: only with `syscall: "getaddrinfo"`. */
const lookupCodes = new Set(["EAI_AGAIN", "ENOTFOUND"]);
/** A socket closed during the TLS handshake; its code is `ECONNRESET`. */
const handshakeClosed =
  "Client network socket disconnected before secure TLS connection was established";
/**
 * The session's proxy answering the tunnel request (`CONNECT`) with something
 * other than 200; undici reports it as an aborted request.
 */
const proxyTunnel = /^Proxy response \((\d+)\) !== 200 when HTTP Tunneling$/u;
/** The proxy could not reach the host: a 502, 503 or 504 to the tunnel. */
const proxyTunnelTransient = new Set([502, 503, 504]);
/** A certificate that does not verify; the request was never sent. */
const certificateCode =
  /^(?:CERT_\w+|UNABLE_TO_\w+|ERR_TLS_CERT_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)$/u;

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

/**
 * What one link of the chain says about the request: it never left and a
 * repeat may pass (`unsent`), it never left and a repeat gets the same
 * answer (`refused`), it may have arrived (`uncertain`), or nothing.
 */
function linkLoss(link: Error) {
  const { code, syscall } = errnoSchema.parse(link);
  const tunnel = proxyTunnel.exec(link.message);
  if (tunnel) {
    return proxyTunnelTransient.has(Number(tunnel[1])) ? "unsent" : "refused";
  }
  if (code !== undefined && certificateCode.test(code)) return "refused";
  if (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    (code !== undefined && connectCodes.has(code) && syscall === "connect") ||
    (code !== undefined &&
      lookupCodes.has(code) &&
      syscall === "getaddrinfo") ||
    link.message === handshakeClosed
  ) {
    return "unsent";
  }
  if (code !== undefined && droppedCodes.has(code)) return "uncertain";
  return undefined;
}

/**
 * How the request was lost, by the most telling link of the error's cause
 * chain; undefined when the failure is not the network's.
 */
function lostRequest(error: Error) {
  const losses = new Set(causeChain(error).map((link) => linkLoss(link)));
  if (losses.has("refused")) return "refused";
  if (losses.has("unsent")) return "unsent";
  if (losses.has("uncertain")) return "uncertain";
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

interface RetryRequest {
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
 * safe to repeat (see above). A refusal for good fails at once with what it
 * was; any other failure, and the last one, is thrown as it came.
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
      if (loss === "refused") {
        throw new Error(
          `${request.label}: запрос не ушёл — ${lossDetail(error)}; такой отказ повтором не проходит, драйвер не повторяет`,
          { cause: error }
        );
      }
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
