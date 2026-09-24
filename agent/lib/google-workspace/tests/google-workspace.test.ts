import { connect } from "@vercel/connect/eve";
import type { SessionContext } from "eve/context";
import type {
  Approval,
  ApprovalContext,
  ApprovalPolicy,
} from "eve/tools/approval";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { wakeProactiveWatch } from "@db/services/proactive";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import { accessScopeForUser } from "@shared/identity/access-scope";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));

const proactive = vi.hoisted(() => ({
  wake: vi.fn<typeof wakeProactiveWatch>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));
vi.mock("@db/services/proactive", () => ({
  wakeProactiveWatch: proactive.wake,
}));

import { parseCalendarAvailability } from "@agent/lib/google-workspace/calendar";
import {
  googleReadOnlyWriteRefusal,
  googleWorkspaceAuthOptions,
  googleWorkspaceProvider,
  googleWriteApproval,
} from "@agent/lib/google-workspace/client";
import {
  gmailUpdateLabels,
  gmailUpdateNeedsApproval,
} from "@agent/lib/google-workspace/gmail";
import {
  calendarCreateEvent,
  calendarDeleteEvent,
  calendarUpdateEvent,
} from "@agent/tools/calendar";
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

  it("asks Google for consent from the chat sign-in card so the grant can refresh", async () => {
    // An unsigned token that is not expired is all the OIDC reader checks.
    const claims = btoa(JSON.stringify({ exp: 4_102_444_800 }));
    vi.stubEnv("VERCEL_OIDC_TOKEN", `e30.${claims}.sig`);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        request: "req_1",
        url: "https://accounts.google.com/o/oauth2/v2/auth",
        verifier: "ver_1",
      })
    );
    vi.stubGlobal("fetch", fetch);

    try {
      const auth = connect(googleWorkspaceAuthOptions("full"));
      if (!("startAuthorization" in auth)) {
        throw new Error("Google authorization must be interactive.");
      }
      await auth.startAuthorization({
        callbackUrl: "https://example.com/hook",
        connection: { url: "https://www.googleapis.com" },
        principal: { id: userId, issuer: "better-auth", type: "user" },
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }

    const [endpoint, init] = fetch.mock.calls[0] ?? [];
    expect(endpoint).toEqual(expect.stringContaining("/v1/connect/authorize/"));
    expect(JSON.parse(z.string().parse(init?.body))).toMatchObject({
      prompt: "consent",
      scopes: [...googleWorkspaceScopes.full],
      subject: googleWorkspaceSubject(userId),
    });
  });

  it("checks the grant and wakes Bro's own checks once chat sign-in completes", async () => {
    proactive.wake.mockResolvedValue(true);
    const claims = btoa(JSON.stringify({ exp: 4_102_444_800 }));
    vi.stubEnv("VERCEL_OIDC_TOKEN", `e30.${claims}.sig`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          connector: { id: "cn_1", type: "oauth", uid: "google" },
          expiresAt: Date.now() + 3_600_000,
          token: "ya29.fresh",
        })
      )
      .mockResolvedValueOnce(Response.json({ access_type: "online" }));
    vi.stubGlobal("fetch", fetch);

    try {
      await expect(
        googleWorkspaceProvider("full").completeAuthorization({
          callback: { method: "GET", params: {} },
          callbackUrl: "https://example.com/hook",
          connection: { url: "https://www.googleapis.com" },
          principal: {
            attributes: { workspaceId: scope.workspaceId },
            id: userId,
            issuer: "better-auth",
            type: "user",
          },
        })
      ).resolves.toMatchObject({ token: "ya29.fresh" });
      // A check that found no grant had put the next one off for hours.
      expect(proactive.wake).toHaveBeenCalledExactlyOnceWith(scope);
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("no offline access")
        );
      });
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://oauth2.googleapis.com/tokeninfo"
    );
  });

  it("grants a read-only workspace no scope that can write", () => {
    expect(googleWorkspaceScopes.read_only).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
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
    expect(await approvalOf(calendarUpdateEvent)).toBe("user-approval");
    expect(await approvalOf(calendarDeleteEvent)).toBe("user-approval");
    expect(await approvalOf(gmailDraft)).toBe("not-applicable");
    expect(await approvalOf(gmailUpdate)).toBe("not-applicable");
    expect(settings.access).toHaveBeenCalledWith(scope);
    expect(gmailSearch.approval).toBeUndefined();
    expect(gmailReadThread.approval).toBeUndefined();
  });

  it("asks before changing more than three emails at once", async () => {
    settings.access.mockResolvedValue("full");

    expect(
      await approvalOf(gmailUpdate, { messageIds: ids(3), update: "archive" })
    ).toBe("not-applicable");
    expect(
      await approvalOf(gmailUpdate, { messageIds: ids(4), update: "archive" })
    ).toBe("user-approval");
    expect(
      await approvalOf(gmailUpdate, {
        messageIds: ids(12),
        update: "mark_read",
      })
    ).toBe("user-approval");
    // The messages the turn already changed count too.
    expect(gmailUpdateNeedsApproval({ messageIds: ["x"] }, 2)).toBe(false);
    expect(gmailUpdateNeedsApproval({ messageIds: ["x"] }, 3)).toBe(true);
    // The same id twice is one email.
    expect(
      await approvalOf(gmailUpdate, {
        messageIds: ["a", "a", "b", "b", "c"],
        update: "mark_read",
      })
    ).toBe("not-applicable");
  });

  it("refuses every write in a read-only workspace before any prompt", async () => {
    settings.access.mockResolvedValue("read_only");

    const refusal = { reason: googleReadOnlyWriteRefusal, type: "denied" };
    expect(await approvalOf(gmailSend)).toEqual(refusal);
    expect(await approvalOf(gmailDraft)).toEqual(refusal);
    expect(await approvalOf(gmailUpdate)).toEqual(refusal);
    expect(await approvalOf(calendarCreateEvent)).toEqual(refusal);
    expect(await approvalOf(calendarUpdateEvent)).toEqual(refusal);
    expect(await approvalOf(calendarDeleteEvent)).toEqual(refusal);
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

function ids(count: number) {
  return Array.from(
    { length: count },
    (_, index) => `message-${String(index)}`
  );
}

async function approvalOf<TInput>(
  tool: {
    readonly approval?: Approval<TInput> | undefined;
  },
  toolInput?: ApprovalContext<TInput>["toolInput"]
) {
  const policy = policyOf(tool.approval);
  return policy({
    ...sessionContext(),
    toolInput,
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
