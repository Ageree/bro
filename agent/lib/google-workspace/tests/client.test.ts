import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";
vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "full",
}));

import { withGoogleAuth } from "@agent/lib/google-workspace/client";

function toolContext(requireAuth: ToolContext["requireAuth"]) {
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
      return { token: "ya29.token" };
    },
    requireAuth,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator: "photon-imessage",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "drive-search",
  } satisfies ToolContext;
}

/** The JSON error body Google API calls answer with. */
interface GoogleErrorBody {
  error: {
    code: number;
    details?: { "@type": string; reason: string }[];
    errors: { domain: string; reason: string }[];
    message: string;
    status?: string;
  };
}

/** The shape gaxios gives a failed Google API call. */
function googleError(status: number, data: GoogleErrorBody | ArrayBuffer) {
  return Object.assign(new Error(`Google answered ${String(status)}`), {
    response: { data, status },
  });
}

const insufficientScopeBody: GoogleErrorBody = {
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

/** A Google call that fails with `error`. */
function failWith(error: Error) {
  return async function failingCall(): Promise<never> {
    throw error;
  };
}

async function callFailingWith(error: Error) {
  const requireAuth = vi.fn<ToolContext["requireAuth"]>(() => {
    throw new Error("authorization required");
  });
  let outcome: unknown;
  try {
    await withGoogleAuth(toolContext(requireAuth), failWith(error));
  } catch (cause) {
    outcome = cause;
  }
  return { outcome, requireAuth };
}

describe("withGoogleAuth", () => {
  it("asks for consent again when the token was rejected", async () => {
    const { requireAuth } = await callFailingWith(
      googleError(401, {
        error: { code: 401, errors: [], message: "Invalid Credentials" },
      })
    );
    expect(requireAuth).toHaveBeenCalledOnce();
  });

  it("asks for consent again when the grant predates a scope", async () => {
    const { outcome, requireAuth } = await callFailingWith(
      googleError(403, insufficientScopeBody)
    );
    expect(requireAuth).toHaveBeenCalledOnce();
    expect(outcome).toEqual(new Error("authorization required"));
  });

  it("reads the scope error from a download's byte body", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(insufficientScopeBody)
    );
    const { requireAuth } = await callFailingWith(
      googleError(403, bytes.buffer)
    );
    expect(requireAuth).toHaveBeenCalledOnce();
  });

  it("leaves a file the person cannot open as the call's own failure", async () => {
    const fileError = googleError(403, {
      error: {
        code: 403,
        errors: [{ domain: "global", reason: "insufficientFilePermissions" }],
        message: "The user does not have sufficient permissions for file.",
      },
    });
    const { outcome, requireAuth } = await callFailingWith(fileError);
    expect(requireAuth).not.toHaveBeenCalled();
    expect(outcome).toBe(fileError);
  });
});
