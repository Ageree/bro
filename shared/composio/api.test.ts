import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ComposioError,
  composioRequest,
  isMissingConnectedAccount,
  isTransientComposioFailure,
} from "./api";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("composioRequest", () => {
  it("sends the project key and JSON, and repeats list parameters", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));

    await expect(
      composioRequest(z.object({ ok: z.boolean() }), "/connected_accounts", {
        body: { user_id: "better-auth:user-1" },
        method: "POST",
        query: { statuses: ["ACTIVE", "INITIATED"], user_ids: ["u1"] },
      })
    ).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(z.instanceof(URL).parse(url).toString()).toBe(
      "https://backend.composio.dev/api/v3.1/connected_accounts?statuses=ACTIVE&statuses=INITIATED&user_ids=u1"
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("test-composio-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init?.body).toBe('{"user_id":"better-auth:user-1"}');
  });

  it("turns Composio's refusal into an error with its status and slug", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: {
            message: 'Connected account "ca_1" not found',
            slug: "ConnectedAccount_ResourceNotFound",
          },
        },
        { status: 404 }
      )
    );

    const failure = await composioRequest(z.unknown(), "/x").catch(
      (cause: unknown) => cause
    );

    expect(failure).toBeInstanceOf(ComposioError);
    expect(failure).toMatchObject({
      slug: "ConnectedAccount_ResourceNotFound",
      status: 404,
    });
    expect(isMissingConnectedAccount(failure)).toBe(true);
    expect(isTransientComposioFailure(failure)).toBe(false);
  });

  it("tells a passing outage from configuration", () => {
    expect(
      isTransientComposioFailure(new ComposioError(503, undefined, "down"))
    ).toBe(true);
    expect(isTransientComposioFailure(new TypeError("fetch failed"))).toBe(
      true
    );
    expect(
      isTransientComposioFailure(new ComposioError(401, "APIKey_Invalid", "no"))
    ).toBe(false);
  });
});
