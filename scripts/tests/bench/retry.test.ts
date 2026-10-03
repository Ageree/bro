import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composioProxy,
  findGoogleAccount,
} from "../../bench/account/composio.ts";
import { withRetry } from "../../bench/retry.ts";
import { sendSignInCode, signedInSession } from "../../bench/sign-in.ts";
import {
  certificateRejected,
  connectionReset,
  connectTimeout,
  everyAddressFailed,
  handshakeClosed,
  socketClosed,
  systemError,
  tunnelRefused,
  unknownFailure,
} from "./fetch-failures.ts";

/**
 * The driver's requests over a way out that drops some of them: what is
 * sent again, after what wait, and what fails as before. The sign-in and
 * Composio calls are the driver's own `fetch` calls; eve's go through the
 * same `withRetry` (`conversation.test.ts`).
 */

const host = new URL("https://brobro.tech");

const sessionAnswer = () =>
  Response.json({
    session: { expiresAt: "2026-11-01T00:00:00.000Z" },
    user: { id: "user_1" },
  });

let warnings: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((line: string) => {
    warnings.push(line);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** `fetch` that fails once with `failure`, then answers `answer`. */
function failingOnce(failure: Error, answer: () => Response) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(failure)
    .mockImplementation(() => Promise.resolve(answer()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const sendCode = () => sendSignInCode(host, "+70000000001");

describe("a request that never left", () => {
  it("is sent again after a connect timeout, two seconds later", async () => {
    const fetchMock = failingOnce(connectTimeout(), sessionAnswer);

    const checked = signedInSession(host, "session=1");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(checked).resolves.toMatchObject({ userId: "user_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([
      expect.stringContaining(
        "GET /api/auth/get-session: сбой сети (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error"
      ),
    ]);
    expect(warnings[0]).toContain("повтор через 2 с (1/4)");
  });

  it.each([
    ["a connect timeout", connectTimeout()],
    ["a tunnel the proxy could not open (502)", tunnelRefused(502)],
    ["a tunnel the proxy could not open (503)", tunnelRefused(503)],
    ["a tunnel the proxy could not open (504)", tunnelRefused(504)],
    ["a socket closed during the TLS handshake", handshakeClosed()],
    ["a refused connect", systemError("ECONNREFUSED", "connect")],
    ["an unreachable host", systemError("EHOSTUNREACH", "connect")],
    ["an unreachable network", systemError("ENETUNREACH", "connect")],
    ["a connect the system timed out", systemError("ETIMEDOUT", "connect")],
    ["a name that does not resolve", systemError("ENOTFOUND", "getaddrinfo")],
    ["a lookup that failed for now", systemError("EAI_AGAIN", "getaddrinfo")],
    [
      "every address of the host refused",
      everyAddressFailed(
        ["ECONNREFUSED", "connect"],
        ["ECONNREFUSED", "connect"]
      ),
    ],
    [
      "every address of the host refused or timed out",
      everyAddressFailed(["ECONNREFUSED", "connect"], ["ETIMEDOUT", "connect"]),
    ],
  ])("is sent again even as a POST: %s", async (_name, failure) => {
    const fetchMock = failingOnce(failure, () => Response.json({}));

    const sent = sendCode();
    await vi.advanceTimersByTimeAsync(2000);

    await expect(sent).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^POST \/api\/auth\/phone-number\/send-otp: сбой сети \(.+\) — повтор через 2 с \(1\/4\)$/u
      ),
    ]);
  });

  it("waits longer before each next repeat", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(tunnelRefused())
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    const sent = sendCode();
    await vi.advanceTimersByTimeAsync(2000 + 4000);

    await expect(sent).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warnings).toEqual([
      expect.stringMatching(
        /\(UND_ERR_ABORTED: Proxy response \(502\).* повтор через 2 с \(1\/4\)$/u
      ),
      expect.stringMatching(
        /\(UND_ERR_CONNECT_TIMEOUT: .* повтор через 4 с \(2\/4\)$/u
      ),
    ]);
  });
});

describe("a refusal a repeat would only get again", () => {
  it.each([
    ["the proxy forbids the host (403)", tunnelRefused(403)],
    ["the proxy wants authentication (407)", tunnelRefused(407)],
    ["the certificate does not verify", certificateRejected()],
  ])("fails at once, even as a read: %s", async (_name, failure) => {
    const fetchMock = failingOnce(failure, sessionAnswer);

    await expect(signedInSession(host, "session=1")).rejects.toThrow(
      /^GET \/api\/auth\/get-session: запрос не ушёл — .+; такой отказ повтором не проходит, драйвер не повторяет$/u
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });
});

describe("a request cut off after it left", () => {
  it.each([
    [
      "the other side closed",
      socketClosed(),
      "UND_ERR_SOCKET: other side closed",
    ],
    ["a reset", connectionReset(), "ECONNRESET: read ECONNRESET"],
  ])("is not sent again as a POST: %s", async (_name, failure, detail) => {
    const fetchMock = failingOnce(failure, () => Response.json({}));

    const sent = sendCode();

    await expect(sent).rejects.toThrow(
      `POST /api/auth/phone-number/send-otp: соединение оборвалось, когда запрос уже ушёл (${detail}), — он мог дойти, и драйвер его не повторяет`
    );
    await expect(sent).rejects.toHaveProperty("name", "UncertainDeliveryError");
    // The owner gets one code, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });

  it.each([
    ["the other side closed", socketClosed()],
    ["a reset", connectionReset()],
  ])("is read again as a GET: %s", async (_name, failure) => {
    const fetchMock = failingOnce(failure, sessionAnswer);

    const checked = signedInSession(host, "session=1");
    await vi.advanceTimersByTimeAsync(2000);

    await expect(checked).resolves.toMatchObject({ userId: "user_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("a failure that does not prove the request never left", () => {
  it.each([
    ["a system error after the connect", systemError("EHOSTUNREACH", "read")],
    ["a refused connect without its syscall", systemError("ECONNREFUSED")],
    [
      "several addresses, one of them reset after the connect",
      everyAddressFailed(["ECONNREFUSED", "connect"], ["EHOSTUNREACH", "read"]),
    ],
    ["a failed lookup without its syscall", systemError("ENOTFOUND")],
    ["a failure that names nothing known", unknownFailure()],
  ])("is not sent again, as a POST or a read: %s", async (_name, failure) => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(failure);
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendCode()).rejects.toBe(failure);
    await expect(signedInSession(host, "session=1")).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);
  });
});

describe("when the repeats run out", () => {
  it("fails with the error it failed with before, after four repeats", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.reject(connectTimeout()));
    vi.stubGlobal("fetch", fetchMock);

    // The rejection is awaited while the clock runs the four waits out.
    await Promise.all([
      expect(signedInSession(host, "session=1")).rejects.toThrow(
        new TypeError("fetch failed")
      ),
      vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 16_000),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(warnings).toHaveLength(5);
    expect(warnings.at(-1)).toContain("и после 4 повторов — драйвер сдаётся");
  });
});

it("does not repeat a request whose deadline has passed", async () => {
  const deadline = new AbortController();
  deadline.abort(new Error("turn deadline"));
  const failure = connectTimeout();
  const send = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
  const log = vi.fn<(line: string) => void>();

  await expect(
    withRetry(
      { idempotent: true, label: "чтение", log, signal: deadline.signal },
      send
    )
  ).rejects.toBe(failure);
  expect(send).toHaveBeenCalledTimes(1);
  expect(log).not.toHaveBeenCalled();
});

it("does not repeat an answer: only the network's failures are retried", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(signedInSession(host, "session=1")).rejects.toThrow(
    "does not know this session any more"
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

describe("Composio", () => {
  const apiKey = "composio-key";

  it("does not send a Google write again once it may have arrived", async () => {
    const fetchMock = failingOnce(socketClosed(), () =>
      Response.json({ data: {}, status: 200 })
    );

    await expect(
      composioProxy(
        apiKey,
        "ca_1"
      )({
        body: { raw: "letter" },
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/import",
      })
    ).rejects.toHaveProperty("name", "UncertainDeliveryError");
    // One letter in the mailbox, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a Google read through the proxy again after a reset", async () => {
    const fetchMock = failingOnce(socketClosed(), () =>
      Response.json({ data: { emailAddress: "a@b.c" }, status: 200 })
    );

    const read = composioProxy(
      apiKey,
      "ca_1"
    )({
      method: "GET",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(read).resolves.toEqual({
      data: { emailAddress: "a@b.c" },
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("looks the account up again after a reset", async () => {
    const fetchMock = failingOnce(socketClosed(), () =>
      Response.json({
        items: [{ id: "ca_1", status: "ACTIVE", user_id: "user_1" }],
      })
    );

    const found = findGoogleAccount(apiKey, "user_1");
    await vi.advanceTimersByTimeAsync(2000);

    await expect(found).resolves.toBe("ca_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
