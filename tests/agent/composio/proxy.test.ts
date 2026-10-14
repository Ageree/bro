import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposioError } from "@shared/composio/api";

const composioRequest = vi.hoisted(() =>
  vi.fn<() => Promise<{ data: object; status: number }>>()
);
vi.mock("@shared/composio/api", async (importOriginal) => ({
  ...(await importOriginal()),
  composioRequest,
}));

const read = {
  method: "GET" as const,
  retryRefusedRead: true,
  signal: new AbortController().signal,
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
};
const answer = { data: {}, status: 200 };

afterEach(() => {
  vi.useRealTimers();
  composioRequest.mockReset();
});

async function proxied(
  overrides: { method?: "GET" | "POST"; retryRefusedRead?: boolean } = {}
) {
  const { composioProxy } = await import("@agent/lib/composio/proxy");
  return composioProxy("ca_1", { ...read, ...overrides });
}

describe("composioProxy", () => {
  it("asks once more for a read after a bare 403 of Composio's own", async () => {
    vi.useFakeTimers();
    composioRequest
      .mockRejectedValueOnce(new ComposioError(403, undefined, "refused"))
      .mockResolvedValueOnce(answer);

    const result = proxied();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toEqual(answer);
    expect(composioRequest).toHaveBeenCalledTimes(2);
  });

  it("never repeats a write, and not a read whose caller retries itself", async () => {
    composioRequest.mockRejectedValue(
      new ComposioError(403, undefined, "refused")
    );

    await expect(proxied({ method: "POST" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(proxied({ retryRefusedRead: false })).rejects.toMatchObject({
      status: 403,
    });
    expect(composioRequest).toHaveBeenCalledTimes(2);
  });

  it("stops after the one retry", async () => {
    vi.useFakeTimers();
    composioRequest.mockRejectedValue(
      new ComposioError(403, undefined, "refused")
    );

    await Promise.all([
      expect(proxied()).rejects.toMatchObject({ status: 403 }),
      vi.advanceTimersByTimeAsync(3_000),
    ]);
    expect(composioRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    new ComposioError(403, "ConnectedAccount_NotFound", "gone"),
    new ComposioError(429, undefined, "slow down"),
  ])("does not retry %s", async (error) => {
    composioRequest.mockRejectedValue(error);

    await expect(proxied()).rejects.toBe(error);
    expect(composioRequest).toHaveBeenCalledTimes(1);
  });

  it("passes the provider's own 403 on without asking again", async () => {
    const insufficientScopes = { data: {}, status: 403 };
    composioRequest.mockResolvedValue(insufficientScopes);

    await expect(proxied()).resolves.toBe(insufficientScopes);
    expect(composioRequest).toHaveBeenCalledTimes(1);
  });
});
