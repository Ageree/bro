import type { SessionContext } from "eve/context";
import type {
  Approval,
  ApprovalContext,
  ApprovalPolicy,
} from "eve/tools/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { wakeProactiveWatch } from "@db/services/proactive";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { type FakeComposio, fakeComposio } from "@tests/helpers/composio";

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
  googleNotConnectedWriteRefusal,
  googleReadOnlyWriteRefusal,
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

const userId = "better-auth:user-123";
const scope = accessScopeForUser(userId);
const principal = {
  attributes: { workspaceId: scope.workspaceId },
  id: userId,
  issuer: "better-auth",
  type: "user" as const,
};

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  composio = fakeComposio();
});

describe("Google Workspace", () => {
  it("finds the person's active Google account at the level, or asks to sign in", async () => {
    composio.connect({
      id: "ca_other_user",
      toolkit: "googlesuper",
      userId: "better-auth:someone-else",
    });
    composio.connect({
      authConfigId: "ac_google_read_only",
      id: "ca_read",
      toolkit: "googlesuper",
      userId,
    });
    const full = googleWorkspaceProvider("full");

    await expect(
      full.getToken({ connection: { url: "" }, principal })
    ).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });

    composio.connect({ id: "ca_full", toolkit: "googlesuper", userId });
    await expect(
      full.getToken({ connection: { url: "" }, principal })
    ).resolves.toEqual({ token: "ca_full" });
    await expect(
      googleWorkspaceProvider("read_only").getToken({
        connection: { url: "" },
        principal,
      })
    ).resolves.toEqual({ token: "ca_read" });
  });

  it("puts a Composio Connect Link for the person on the chat sign-in card", async () => {
    const started = await googleWorkspaceProvider("full").startAuthorization({
      callbackUrl: "https://example.com/eve/v1/connections/google/callback/a/b",
      connection: { url: "" },
      principal,
    });

    expect(started).toEqual({
      challenge: {
        displayName: "Google",
        expiresAt: "2026-09-24T12:10:00.000Z",
        url: "https://connect.composio.dev/link/lk_1",
      },
      resume: { connectedAccountId: "ca_link_1" },
    });
    expect(
      composio.requests.find(({ path }) => path === "/connected_accounts/link")
        ?.body
    ).toEqual({
      auth_config_id: "ac_google_full",
      callback_url:
        "https://example.com/eve/v1/connections/google/callback/a/b",
      user_id: userId,
    });
  });

  it("completes sign-in only with the account the link made, then wakes Bro's own checks", async () => {
    proactive.wake.mockResolvedValue(true);
    const older = composio.connect({
      id: "ca_older",
      toolkit: "googlesuper",
      userId,
    });
    const provider = googleWorkspaceProvider("full");
    const { resume } = await provider.startAuthorization({
      callbackUrl: "https://example.com/hook",
      connection: { url: "" },
      principal,
    });
    const minted = composio.accounts.find(
      ({ id }) => id === resume?.connectedAccountId
    );
    if (minted) minted.status = "ACTIVE";

    await expect(
      provider.completeAuthorization({
        callback: {
          method: "GET",
          params: { connected_account_id: "ca_link_2", status: "success" },
        },
        callbackUrl: "https://example.com/hook",
        connection: { url: "" },
        principal,
        resume,
      })
    ).resolves.toEqual({ token: "ca_link_2" });
    // A check that found no grant had put the next one off for hours.
    expect(proactive.wake).toHaveBeenCalledExactlyOnceWith(scope);
    // One connection: the older account is removed without revoking the
    // grant the new one may share.
    expect(composio.accounts.map(({ id }) => id)).toEqual(["ca_link_2"]);
    expect(older.status).toBe("ACTIVE");
    expect(composio.requests.some(({ path }) => path.endsWith("/revoke"))).toBe(
      false
    );
  });

  it("fails sign-in the person declined without waking anything", async () => {
    const provider = googleWorkspaceProvider("full");
    const { resume } = await provider.startAuthorization({
      callbackUrl: "https://example.com/hook",
      connection: { url: "" },
      principal,
    });

    await expect(
      provider.completeAuthorization({
        callback: { method: "GET", params: { status: "failed" } },
        callbackUrl: "https://example.com/hook",
        connection: { url: "" },
        principal,
        resume,
      })
    ).rejects.toMatchObject({ name: "ConnectionAuthorizationFailedError" });
    expect(proactive.wake).not.toHaveBeenCalled();
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
    composio.connect({ toolkit: "googlesuper", userId });

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

  // Owner 26.09: nothing but a payment is confirmed. What the person asked
  // for in their own message is sent, created or deleted at once; a browser
  // run's report is the page's text, so there it waits for the card.
  it("sends and changes the calendar at once in the person's own turn", async () => {
    settings.access.mockResolvedValue("full");
    composio.connect({ toolkit: "googlesuper", userId });
    const writes = [
      gmailSend,
      calendarCreateEvent,
      calendarUpdateEvent,
      calendarDeleteEvent,
    ];

    expect(
      await Promise.all(
        writes.map(async (tool) =>
          approvalOf(tool, undefined, "telegram-webhook")
        )
      )
    ).toEqual(Array.from({ length: 4 }, () => "not-applicable"));
    expect(
      await Promise.all(
        writes.map(async (tool) =>
          approvalOf(tool, undefined, "browser-result")
        )
      )
    ).toEqual(Array.from({ length: 4 }, () => "user-approval"));
    expect(
      await approvalOf(
        gmailUpdate,
        { messageIds: ids(12), update: "mark_read" },
        "photon-imessage"
      )
    ).toBe("not-applicable");
  });

  it("asks before changing more than three emails at once", async () => {
    settings.access.mockResolvedValue("full");
    composio.connect({ toolkit: "googlesuper", userId });

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

  it("shows no write card while Google is not connected, and says so", async () => {
    settings.access.mockResolvedValue("full");
    // Someone else's grant and a link never finished are not the person's.
    composio.connect({
      toolkit: "googlesuper",
      userId: "better-auth:someone-else",
    });
    composio.connect({ status: "INITIATED", toolkit: "googlesuper", userId });

    const refusal = { reason: googleNotConnectedWriteRefusal, type: "denied" };
    expect(await approvalOf(gmailSend)).toEqual(refusal);
    expect(await approvalOf(calendarCreateEvent)).toEqual(refusal);
    expect(await approvalOf(calendarUpdateEvent)).toEqual(refusal);
    expect(await approvalOf(calendarDeleteEvent)).toEqual(refusal);
    expect(
      await approvalOf(gmailUpdate, { messageIds: ids(4), update: "archive" })
    ).toEqual(refusal);
    // No card to show: a draft or a small tidy-up meets eve's sign-in card.
    expect(await approvalOf(gmailDraft)).toBe("not-applicable");
    expect(googleNotConnectedWriteRefusal).toContain("connect_google");
    expect(googleNotConnectedWriteRefusal).toContain("не подключён");
  });

  it("still shows the card when Composio cannot say just now", async () => {
    settings.access.mockResolvedValue("full");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    composio.fetch.mockResolvedValue(
      Response.json({ error: { message: "down" } }, { status: 502 })
    );

    expect(await approvalOf(gmailSend)).toBe("user-approval");
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
    // The person chose read-only: Bro says the action is unavailable and
    // does not push for full access (RU d06).
    expect(googleReadOnlyWriteRefusal).toContain("недоступно");
    expect(googleReadOnlyWriteRefusal).toContain(
      "Не предлагай и не уговаривай перейти на полный доступ"
    );
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
  toolInput?: ApprovalContext<TInput>["toolInput"],
  authenticator?: string
) {
  const policy = policyOf(tool.approval);
  return policy({
    ...sessionContext(authenticator),
    toolInput,
    abortSignal: new AbortController().signal,
    approvedTools: new Set(),
    callId: "call-1",
    toolName: "google-workspace-test",
  });
}

function sessionContext(authenticator = "google-workspace-test") {
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
          authenticator,
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
