import type { SessionContext } from "eve/context";
import type { Approval, ApprovalPolicy } from "eve/tools/approval";
import { describe, expect, it, vi } from "vitest";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import { accessScopeForUser } from "@shared/identity/access-scope";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));

import { parseCalendarAvailability } from "@agent/lib/google-workspace/calendar";
import {
  googleReadOnlyWriteRefusal,
  googleWorkspaceAuthOptions,
  googleWriteApproval,
} from "@agent/lib/google-workspace/client";
import { gmailUpdateLabels } from "@agent/lib/google-workspace/gmail";
import { calendarCreateEvent } from "@agent/tools/calendar";
import {
  gmailDraft,
  gmailReadThread,
  gmailSearch,
  gmailSend,
  gmailUpdate,
} from "@agent/tools/gmail";
import {
  googleWorkspaceScopes,
  googleWorkspaceSubject,
  googleWorkspaceTokenParams,
} from "@shared/google-workspace/connection";

const userId = "better-auth:user-123";
const scope = accessScopeForUser(userId);

describe("Google Workspace", () => {
  it("uses explicit least-privilege scope sets", () => {
    for (const scopes of Object.values(googleWorkspaceScopes)) {
      expect(scopes).not.toContain("*");
      expect(scopes).not.toContain("https://mail.google.com/");
    }
    for (const access of ["full", "read_only"] as const) {
      expect(googleWorkspaceTokenParams(userId, access)).toEqual({
        scopes: [...googleWorkspaceScopes[access]],
        subject: googleWorkspaceSubject(userId),
      });
      expect(googleWorkspaceAuthOptions(access).tokenParams).toEqual({
        scopes: [...googleWorkspaceScopes[access]],
      });
      expect(googleWorkspaceAuthOptions(access).validate).toBe(true);
    }
  });

  it("grants a read-only workspace no scope that can write", () => {
    expect(googleWorkspaceScopes.read_only).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
    ]);
    for (const granted of googleWorkspaceScopes.read_only) {
      expect(granted).not.toMatch(/modify|compose|send|calendar\.events$/u);
    }
    expect(googleWorkspaceScopes.full).toContain(
      "https://www.googleapis.com/auth/gmail.modify"
    );
  });

  it("uses a user-scoped connector subject", () => {
    expect(googleWorkspaceSubject(userId)).toEqual({
      id: userId,
      issuer: "openinstinct",
      type: "user",
    });
  });

  it("maps reversible Gmail actions", () => {
    expect(gmailUpdateLabels("archive")).toEqual({
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
    });
    expect(gmailUpdateLabels("mark_unread")).toEqual({
      addLabelIds: ["UNREAD"],
      removeLabelIds: [],
    });
  });

  it("asks before sending or creating and lets drafts and inbox tidying run", async () => {
    settings.access.mockResolvedValue("full");

    expect(await approvalOf(gmailSend)).toBe("user-approval");
    expect(await approvalOf(calendarCreateEvent)).toBe("user-approval");
    expect(await approvalOf(gmailDraft)).toBe("not-applicable");
    expect(await approvalOf(gmailUpdate)).toBe("not-applicable");
    expect(settings.access).toHaveBeenCalledWith(scope);
    expect(gmailSearch.approval).toBeUndefined();
    expect(gmailReadThread.approval).toBeUndefined();
  });

  it("refuses every write in a read-only workspace before any prompt", async () => {
    settings.access.mockResolvedValue("read_only");

    const refusal = { reason: googleReadOnlyWriteRefusal, type: "denied" };
    expect(await approvalOf(gmailSend)).toEqual(refusal);
    expect(await approvalOf(gmailDraft)).toEqual(refusal);
    expect(await approvalOf(gmailUpdate)).toEqual(refusal);
    expect(await approvalOf(calendarCreateEvent)).toEqual(refusal);
    expect(
      await googleWriteApproval(sessionContext(), "user-approval")
    ).toEqual(refusal);
  });

  it("does not treat calendar API errors as availability", () => {
    expect(() =>
      parseCalendarAvailability({
        calendars: {
          "missing@example.com": {
            errors: [{ domain: "global", reason: "notFound" }],
          },
        },
      })
    ).toThrow(/missing@example\.com: notFound/u);
  });
});

async function approvalOf<TInput>(tool: {
  readonly approval?: Approval<TInput> | undefined;
}) {
  const policy = policyOf(tool.approval);
  return policy({
    ...sessionContext(),
    abortSignal: new AbortController().signal,
    approvedTools: new Set(),
    callId: "call-1",
    toolName: "google-workspace-test",
  });
}

function sessionContext() {
  return {
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator: "google-workspace-test",
          principalId: userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
  } satisfies SessionContext;
}

function policyOf<TInput>(
  approval: Approval<TInput> | undefined
): ApprovalPolicy<TInput> {
  if (approval === undefined) {
    throw new Error("The tool has no approval policy.");
  }
  return "request" in approval ? approval.request : approval;
}
