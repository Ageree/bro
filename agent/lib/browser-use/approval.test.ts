import type { ApprovalContext } from "eve/tools/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as BrowserAutonomy from "@db/services/browser-autonomy";
import {
  broadBrowserAutonomyPolicy,
  defaultBrowserAutonomyPolicy,
} from "@shared/browser/autonomy";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { browserTaskApproval } from "./approval";

const getPolicyMock = vi.spyOn(BrowserAutonomy, "getBrowserAutonomyPolicy");
const userId = "better-auth:user-1";
const scope = accessScopeForUser(userId);

interface ApprovalTestInput {
  readonly action: "cancel" | "continue" | "start" | "status";
  readonly allowPayment?: boolean;
  readonly capability?:
    | "account-change"
    | "browse"
    | "delete"
    | "prepare"
    | "purchase"
    | "send";
}

function context(
  toolInput: ApprovalTestInput,
  workspaceId = scope.workspaceId
): ApprovalContext<ApprovalTestInput> {
  return {
    abortSignal: AbortSignal.abort(),
    approvedTools: new Set(),
    callId: "call-1",
    getSandbox: () => {
      throw new Error("The approval policy does not use a sandbox.");
    },
    getSkill: () => {
      throw new Error("The approval policy does not use a skill.");
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId },
          authenticator: "better-auth",
          principalId: userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolInput,
    toolName: "browser_task",
  };
}

describe("browser task approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPolicyMock.mockResolvedValue(defaultBrowserAutonomyPolicy);
  });

  it.each(["browse", "prepare"] satisfies ApprovalTestInput["capability"][])(
    "allows safe %s work without a prompt",
    async (capability) => {
      await expect(
        browserTaskApproval(context({ action: "start", capability }))
      ).resolves.toBe("not-applicable");
      expect(getPolicyMock).not.toHaveBeenCalled();
    }
  );

  it.each(["cancel", "status"] satisfies ApprovalTestInput["action"][])(
    "allows %s without capability or a prompt",
    async (action) => {
      await expect(browserTaskApproval(context({ action }))).resolves.toBe(
        "not-applicable"
      );
      expect(getPolicyMock).not.toHaveBeenCalled();
    }
  );

  it("requires approval for consequential work by default", async () => {
    await expect(
      browserTaskApproval(context({ action: "continue", capability: "delete" }))
    ).resolves.toBe("user-approval");
    expect(getPolicyMock).toHaveBeenCalledExactlyOnceWith(scope);
  });

  it("allows a granted consequential capability", async () => {
    getPolicyMock.mockResolvedValue(broadBrowserAutonomyPolicy);

    await expect(
      browserTaskApproval(
        context({
          action: "start",
          allowPayment: true,
          capability: "purchase",
        })
      )
    ).resolves.toBe("not-applicable");
  });

  it("does not let allowPayment authorize another capability", async () => {
    getPolicyMock.mockResolvedValue(broadBrowserAutonomyPolicy);

    await expect(
      browserTaskApproval(
        context({
          action: "start",
          allowPayment: true,
          capability: "send",
        })
      )
    ).resolves.toBe("user-approval");
    expect(getPolicyMock).not.toHaveBeenCalled();
  });

  it("does not consult policy for a forged personal workspace", async () => {
    await expect(
      browserTaskApproval(
        context({ action: "start", capability: "delete" }, "personal:forged")
      )
    ).resolves.toEqual({
      type: "denied",
      reason: "The authenticated user cannot access this workspace.",
    });
    expect(getPolicyMock).not.toHaveBeenCalled();
  });
});
