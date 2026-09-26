import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
  GoogleUnreadableAnswerError,
  withGoogleAuth,
} from "@agent/lib/google-workspace/client";

const profileUrl = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  composio = fakeComposio();
  composio.connect({ id: "ca_google", toolkit: "googlesuper" });
});

const insufficientScopeBody = {
  error: {
    code: 403,
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      },
    ],
    errors: [{ domain: "global", reason: "insufficientPermissions" }],
    message: "Request had insufficient authentication scopes.",
    status: "PERMISSION_DENIED",
  },
};

async function readProfile() {
  const ctx = composioToolContext("ca_google");
  let outcome: unknown;
  try {
    outcome = await withGoogleAuth(ctx, async (google) =>
      google.json(z.object({ emailAddress: z.string() }), { url: profileUrl })
    );
  } catch (cause) {
    outcome = cause;
  }
  return { ctx, outcome };
}

describe("withGoogleAuth", () => {
  it("calls Google through Composio's proxy with the person's account", async () => {
    composio.proxy.mockResolvedValue({
      data: { emailAddress: "ada@example.com" },
    });

    const { ctx, outcome } = await readProfile();

    expect(outcome).toEqual({ emailAddress: "ada@example.com" });
    expect(ctx.getToken).toHaveBeenCalledWith(expect.anything(), {
      authKey: "google-workspace",
    });
    const [request] = composio.proxy.mock.calls[0] ?? [];
    expect(request?.connectedAccountId).toBe("ca_google");
    expect(request?.method).toBe("GET");
    expect(request?.url.toString()).toBe(profileUrl);
    // Composio signs the call; Bro never holds or sends a Google token.
    expect(request?.headers).toEqual({});
    const [, init] = composio.fetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("x-api-key")).toBe(
      "test-composio-key"
    );
  });

  it("asks for consent again when Google rejects the grant", async () => {
    composio.proxy.mockResolvedValue({
      data: {
        error: { code: 401, errors: [], message: "Invalid Credentials" },
      },
      status: 401,
    });

    const { ctx } = await readProfile();

    expect(ctx.requireAuth).toHaveBeenCalledOnce();
    expect(ctx.requireAuth.mock.calls[0]?.[0]).toBe(
      ctx.getToken.mock.calls[0]?.[0]
    );
  });

  it("asks for consent again when the grant predates a scope", async () => {
    composio.proxy.mockResolvedValue({
      data: insufficientScopeBody,
      status: 403,
    });

    const { ctx, outcome } = await readProfile();

    expect(ctx.requireAuth).toHaveBeenCalledOnce();
    expect(outcome).toEqual(new Error("authorization required"));
  });

  it("reads the scope error from a body the proxy left as text", async () => {
    composio.proxy.mockResolvedValue({
      data: JSON.stringify(insufficientScopeBody),
      status: 403,
    });

    const { ctx } = await readProfile();

    expect(ctx.requireAuth).toHaveBeenCalledOnce();
  });

  it("asks for consent again when Composio no longer has the account", async () => {
    composio.accounts.splice(0);

    const { ctx } = await readProfile();

    expect(ctx.requireAuth).toHaveBeenCalledOnce();
    expect(composio.proxy).not.toHaveBeenCalled();
  });

  it("leaves a file the person cannot open as the call's own failure", async () => {
    composio.proxy.mockResolvedValue({
      data: {
        error: {
          code: 403,
          errors: [{ domain: "global", reason: "insufficientFilePermissions" }],
          message: "The user does not have sufficient permissions for file.",
        },
      },
      status: 403,
    });

    const { ctx, outcome } = await readProfile();

    expect(ctx.requireAuth).not.toHaveBeenCalled();
    expect(outcome).toBeInstanceOf(GoogleApiError);
    expect(outcome).toMatchObject({ status: 403 });
  });
});

describe("a JSON answer the proxy hands over as text", () => {
  const listSchema = z.object({
    messages: z.array(z.object({ id: z.string() })).optional(),
  });
  async function listMail() {
    return withGoogleAuth(composioToolContext("ca_google"), async (google) =>
      google.json(listSchema, { url: `${profileUrl}/../messages` })
    );
  }

  it("reads an empty 204 body as an empty list", async () => {
    composio.proxy.mockResolvedValue({ data: "", status: 204 });

    await expect(listMail()).resolves.toEqual({});
  });

  it("parses JSON text", async () => {
    composio.proxy.mockResolvedValue({
      data: JSON.stringify({ messages: [{ id: "m1" }] }),
    });

    await expect(listMail()).resolves.toEqual({ messages: [{ id: "m1" }] });
  });

  it("names text that is not JSON by its start, not a schema mismatch", async () => {
    const page = `<html>${"x".repeat(200)}</html>`;
    composio.proxy.mockResolvedValue({ data: page });

    const failure = await listMail().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(GoogleUnreadableAnswerError);
    expect(failure).toMatchObject({ bodyStart: page.slice(0, 80) });
  });
});
