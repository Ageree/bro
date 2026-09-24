import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "full",
}));

import {
  GoogleApiError,
  GoogleRateLimitError,
  googleRateLimitMessage,
  isGoogleRateLimit,
} from "@agent/lib/google-workspace/client";
import { searchGmail } from "@agent/lib/google-workspace/gmail";
import { ComposioError } from "@shared/composio/api";

function googleError(
  status: number,
  error: {
    errors?: { reason: string }[];
    message?: string;
  } = {}
) {
  return new GoogleApiError(status, {
    details: [],
    errors: error.errors ?? [],
    message: error.message,
  });
}

const quotaExceededBody = {
  error: {
    errors: [{ reason: "rateLimitExceeded" }],
    message:
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'",
  },
};

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  composio = fakeComposio();
  composio.connect({ id: "ca_google", toolkit: "googlesuper" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isGoogleRateLimit", () => {
  it("recognises 429 and quota 403s but not a refused scope", () => {
    expect(isGoogleRateLimit(googleError(429))).toBe(true);
    expect(
      isGoogleRateLimit(
        googleError(403, {
          errors: [{ reason: "rateLimitExceeded" }],
          message: "Quota exceeded",
        })
      )
    ).toBe(true);
    expect(
      isGoogleRateLimit(
        googleError(403, { message: "User-rate limit exceeded." })
      )
    ).toBe(true);
    expect(
      isGoogleRateLimit(
        googleError(403, {
          errors: [{ reason: "insufficientPermissions" }],
          message: "Request had insufficient authentication scopes.",
        })
      )
    ).toBe(false);
    expect(isGoogleRateLimit(googleError(500))).toBe(false);
  });

  it("treats Composio throttling its proxy as a rate limit too", () => {
    expect(
      isGoogleRateLimit(new ComposioError(429, "RateLimit", "Too many"))
    ).toBe(true);
    expect(
      isGoogleRateLimit(new ComposioError(400, "Bad", "Bad request"))
    ).toBe(false);
  });
});

describe("withGoogleAuth under rate limits", () => {
  it("backs off and retries a rate-limited call", async () => {
    composio.proxy
      .mockResolvedValueOnce({ data: {}, status: 429 })
      .mockResolvedValueOnce({ data: { messages: [] } });

    const search = searchGmail(
      composioToolContext("ca_google"),
      "from:bank",
      5
    );
    await vi.runAllTimersAsync();

    await expect(search).resolves.toEqual([]);
    expect(composio.proxy).toHaveBeenCalledTimes(2);
  });

  it("reports a lasting limit honestly instead of as a disconnect", async () => {
    composio.proxy.mockResolvedValue({ data: quotaExceededBody, status: 403 });

    const settled = Promise.allSettled([
      searchGmail(composioToolContext("ca_google"), "from:bank", 5),
    ]);
    await vi.runAllTimersAsync();
    const [result] = await settled;

    expect(
      result.status === "rejected" ? result.reason : result
    ).toBeInstanceOf(GoogleRateLimitError);

    expect(composio.proxy).toHaveBeenCalledTimes(3);
    expect(googleRateLimitMessage).toContain(
      "Google временно ограничил запросы"
    );
    expect(googleRateLimitMessage).toContain("не отключение");
    expect(googleRateLimitMessage).toContain("connect_google не нужен");
  });

  it("does not retry any other refusal", async () => {
    composio.proxy.mockResolvedValue({
      data: { error: { message: "Not Found" } },
      status: 404,
    });

    await expect(
      searchGmail(composioToolContext("ca_google"), "from:bank", 5)
    ).rejects.toThrow("Google answered 404: Not Found");
    expect(composio.proxy).toHaveBeenCalledOnce();
  });
});
