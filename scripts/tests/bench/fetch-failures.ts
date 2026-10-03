/**
 * What Node's `fetch` (undici) throws when the way out drops a request,
 * shaped as Node 24 throws them (checked against local servers and the
 * cloud session's proxy).
 */

const failed = (cause: Error) => new TypeError("fetch failed", { cause });

const coded = (message: string, code: string, name = "Error") =>
  Object.assign(new Error(message), { code, name });

/** The connection never came up: nothing of the request was sent. */
export const connectTimeout = () =>
  failed(
    coded(
      "Connect Timeout Error (attempted address: brobro.tech:443, timeout: 10000ms)",
      "UND_ERR_CONNECT_TIMEOUT",
      "ConnectTimeoutError"
    )
  );

/** The session's proxy could not reach the host: the tunnel was refused. */
export const tunnelRefused = () =>
  failed(
    coded(
      "Proxy response (502) !== 200 when HTTP Tunneling",
      "UND_ERR_ABORTED",
      "AbortError"
    )
  );

/** The connection closed after the request went out: it may have arrived. */
export const socketClosed = () =>
  failed(coded("other side closed", "UND_ERR_SOCKET", "SocketError"));

/** A reset as a stream's body reports it, which eve does not reconnect on. */
export const readReset = () =>
  Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
    syscall: "read",
  });
