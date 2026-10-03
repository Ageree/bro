import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSignInCode, signedInSession } from "../../bench/sign-in.ts";
import {
  connectTimeout,
  socketClosed,
  tunnelRefused,
} from "./fetch-failures.ts";

/**
 * The driver's requests over a way out that drops some of them: what is
 * sent again, after what wait, and what fails as before. The sign-in calls
 * are the driver's own `fetch` calls; eve's go through the same `withRetry`
 * (`conversation.test.ts`).
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

describe("a request that never left", () => {
  it("is sent again after a connect timeout, two seconds later", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValueOnce(sessionAnswer());
    vi.stubGlobal("fetch", fetchMock);

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

  it("is sent again even as a POST: a refused tunnel or a connect timeout", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(tunnelRefused())
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValueOnce(Response.json({ status: true }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = sendSignInCode(host, "+70000000001");
    await vi.advanceTimersByTimeAsync(2000 + 4000);

    await expect(sent).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^POST \/api\/auth\/phone-number\/send-otp: сбой сети \(UND_ERR_ABORTED: Proxy response \(502\).* повтор через 2 с \(1\/4\)$/u
      ),
      expect.stringMatching(
        /\(UND_ERR_CONNECT_TIMEOUT: .* повтор через 4 с \(2\/4\)$/u
      ),
    ]);
  });
});

describe("a request cut off after it left", () => {
  it("is not sent again as a POST: the code would go to the owner twice", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(socketClosed());
    vi.stubGlobal("fetch", fetchMock);

    const sent = sendSignInCode(host, "+70000000001");

    await expect(sent).rejects.toThrow(
      "POST /api/auth/phone-number/send-otp: соединение оборвалось, когда запрос уже ушёл (UND_ERR_SOCKET: other side closed), — он мог дойти, и драйвер его не повторяет"
    );
    await expect(sent).rejects.toHaveProperty("name", "UncertainDeliveryError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });

  it("is read again as a GET: reading changes nothing", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(socketClosed())
      .mockResolvedValueOnce(sessionAnswer());
    vi.stubGlobal("fetch", fetchMock);

    const checked = signedInSession(host, "session=1");
    await vi.advanceTimersByTimeAsync(2000);

    await expect(checked).resolves.toMatchObject({ userId: "user_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
