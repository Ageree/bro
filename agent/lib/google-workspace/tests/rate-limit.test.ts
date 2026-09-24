import type * as GmailPackage from "@googleapis/gmail";
import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

const google = vi.hoisted(() => ({
  list: vi.fn<() => Promise<{ data: { messages?: { id: string }[] } }>>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "full",
}));

vi.mock("@googleapis/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof GmailPackage>()),
  gmail: () => ({ users: { messages: { list: google.list } } }),
}));

import {
  GoogleRateLimitError,
  googleRateLimitMessage,
  isGoogleRateLimit,
} from "@agent/lib/google-workspace/client";
import { searchGmail } from "@agent/lib/google-workspace/gmail";

const scope = accessScopeForUser("better-auth:user-1");

function googleError(
  status: number,
  error: { errors?: { reason: string }[]; message?: string } = {}
) {
  return Object.assign(new Error(error.message ?? "Google error"), {
    response: { data: { error }, status },
  });
}

const quotaExceeded = googleError(403, {
  errors: [{ reason: "rateLimitExceeded" }],
  message:
    "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isGoogleRateLimit", () => {
  it("recognises 429 and quota 403s but not a refused scope", () => {
    expect(isGoogleRateLimit(googleError(429))).toBe(true);
    expect(isGoogleRateLimit(quotaExceeded)).toBe(true);
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
});

describe("withGoogleAuth under rate limits", () => {
  it("backs off and retries a rate-limited call", async () => {
    google.list
      .mockRejectedValueOnce(googleError(429))
      .mockResolvedValueOnce({ data: { messages: [] } });

    const search = searchGmail(toolContext(), "from:bank", 5);
    await vi.runAllTimersAsync();

    await expect(search).resolves.toEqual([]);
    expect(google.list).toHaveBeenCalledTimes(2);
  });

  it("reports a lasting limit honestly instead of as a disconnect", async () => {
    google.list.mockRejectedValue(quotaExceeded);

    const settled = Promise.allSettled([
      searchGmail(toolContext(), "from:bank", 5),
    ]);
    await vi.runAllTimersAsync();
    const [result] = await settled;

    expect(
      result.status === "rejected" ? result.reason : result
    ).toBeInstanceOf(GoogleRateLimitError);

    expect(google.list).toHaveBeenCalledTimes(3);
    expect(googleRateLimitMessage).toContain(
      "Google временно ограничил запросы"
    );
    expect(googleRateLimitMessage).toContain("не отключение");
    expect(googleRateLimitMessage).toContain("connect_google не нужен");
  });

  it("does not retry any other refusal", async () => {
    google.list.mockRejectedValue(googleError(404));

    await expect(searchGmail(toolContext(), "from:bank", 5)).rejects.toThrow(
      "Google error"
    );
    expect(google.list).toHaveBeenCalledOnce();
  });
});

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    async getToken() {
      return { token: "google-access-token" };
    },
    requireAuth() {
      throw new Error("Authorization is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator: "rate-limit-test",
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "gmail-search",
  } satisfies ToolContext;
}
