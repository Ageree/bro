import type * as GmailPackage from "@googleapis/gmail";
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

const google = vi.hoisted(() => ({
  batchModify:
    vi.fn<
      (request: {
        readonly requestBody: { readonly ids: readonly string[] };
      }) => Promise<object>
    >(),
  list: vi.fn<
    (request: {
      readonly q: string;
    }) => Promise<{ data: { messages?: { id: string }[] } }>
  >(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "full",
}));

vi.mock("@googleapis/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof GmailPackage>()),
  gmail: () => ({
    users: {
      messages: { batchModify: google.batchModify, list: google.list },
    },
  }),
}));

import {
  gmailSecurityAlertQuery,
  updateGmail,
} from "@agent/lib/google-workspace/gmail";

const scope = accessScopeForUser("better-auth:user-1");

beforeEach(() => {
  vi.clearAllMocks();
  google.batchModify.mockResolvedValue({});
  google.list.mockResolvedValue({
    data: { messages: [{ id: "security-alert" }, { id: "elsewhere" }] },
  });
});

describe("updateGmail", () => {
  it("never archives a security alert", async () => {
    const result = await updateGmail(
      toolContext(),
      ["newsletter", "security-alert", "receipt"],
      "archive"
    );

    expect(google.list).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ q: gmailSecurityAlertQuery }),
      expect.anything()
    );
    expect(google.batchModify.mock.calls[0]?.[0].requestBody.ids).toEqual([
      "newsletter",
      "receipt",
    ]);
    expect(result).toEqual({
      action: "archive",
      keptSecurityAlerts: ["security-alert"],
      updatedCount: 2,
    });
  });

  it("calls nothing when every message is a security alert", async () => {
    const result = await updateGmail(
      toolContext(),
      ["security-alert"],
      "archive"
    );

    expect(google.batchModify).not.toHaveBeenCalled();
    expect(result.updatedCount).toBe(0);
  });

  it("looks for alerts only before archiving", async () => {
    await updateGmail(toolContext(), ["security-alert"], "star");

    expect(google.list).not.toHaveBeenCalled();
    expect(google.batchModify).toHaveBeenCalledOnce();
  });

  it("searches Google's own notices and alert subjects in the inbox", () => {
    expect(gmailSecurityAlertQuery.startsWith("in:inbox {")).toBe(true);
    expect(gmailSecurityAlertQuery).toContain("from:accounts.google.com");
    expect(gmailSecurityAlertQuery).toContain(
      'subject:"оповещение системы безопасности"'
    );
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
          authenticator: "gmail-update-test",
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "gmail-update",
  } satisfies ToolContext;
}
