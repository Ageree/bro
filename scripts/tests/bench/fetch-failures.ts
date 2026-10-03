/**
 * What Node's `fetch` (undici) throws when the way out drops a request,
 * shaped as Node 24 throws them (checked against local servers and the
 * cloud session's proxy).
 */

const failed = (cause: Error) => new TypeError("fetch failed", { cause });

const coded = (
  message: string,
  code: string,
  extra: { readonly name?: string; readonly syscall?: string } = {}
) => Object.assign(new Error(message), { code, ...extra });

/** The connection never came up: nothing of the request was sent. */
export const connectTimeout = () =>
  failed(
    coded(
      "Connect Timeout Error (attempted address: brobro.tech:443, timeout: 10000ms)",
      "UND_ERR_CONNECT_TIMEOUT",
      { name: "ConnectTimeoutError" }
    )
  );

/** A system error of the connect or the lookup: `connect ECONNREFUSED …`. */
export const systemError = (code: string, syscall?: string) =>
  failed(
    coded(
      `${syscall ?? "socket"} ${code} brobro.tech`,
      code,
      syscall === undefined ? {} : { syscall }
    )
  );

/**
 * A host with several addresses whose every connect failed: Node's
 * AggregateError carries the first code and no syscall; each attempt, its
 * own code and syscall (`[code, syscall]` per address).
 */
export const everyAddressFailed = (
  ...attempts: readonly (readonly [string, string])[]
) =>
  failed(
    Object.assign(
      new AggregateError(
        attempts.map(([code, syscall], index) =>
          coded(`${syscall} ${code} 127.0.0.${String(index + 1)}:443`, code, {
            syscall,
          })
        )
      ),
      { code: attempts[0]?.[0] ?? "ECONNREFUSED" }
    )
  );

/** The proxy answered the tunnel request with `status`. */
export const tunnelRefused = (status = 502) =>
  failed(
    coded(
      `Proxy response (${String(status)}) !== 200 when HTTP Tunneling`,
      "UND_ERR_ABORTED",
      { name: "AbortError" }
    )
  );

/** The socket closed during the TLS handshake: nothing was sent. */
export const handshakeClosed = () =>
  failed(
    coded(
      "Client network socket disconnected before secure TLS connection was established",
      "ECONNRESET"
    )
  );

/** A certificate that does not verify: nothing was sent, and never will be. */
export const certificateRejected = () =>
  failed(
    coded(
      "self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
      "DEPTH_ZERO_SELF_SIGNED_CERT"
    )
  );

/** The connection closed after the request went out: it may have arrived. */
export const socketClosed = () =>
  failed(coded("other side closed", "UND_ERR_SOCKET", { name: "SocketError" }));

/** A reset after the connection was up (or during TLS: Node cannot tell). */
export const connectionReset = () =>
  failed(coded("read ECONNRESET", "ECONNRESET", { syscall: "read" }));

/** A failure that names nothing the driver knows. */
export const unknownFailure = () => failed(new Error("something else broke"));

/** A reset as a stream's body reports it, which eve does not reconnect on. */
export const readReset = () =>
  coded("read ECONNRESET", "ECONNRESET", { syscall: "read" });
