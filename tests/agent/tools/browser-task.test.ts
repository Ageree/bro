import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";

const runId = "11111111-1111-4111-8111-111111111111";

const readBrowserRunForScope = vi.hoisted(() =>
  vi.fn<(scope: AccessScope, id: string) => Promise<undefined>>(() =>
    Promise.resolve(undefined)
  )
);

type Unused = () => never;

vi.mock("@db/services/browser-runs", () => ({
  claimBrowserRunCompletion: vi.fn<Unused>(),
  createBrowserRun: vi.fn<Unused>(),
  readBrowserProfileId: vi.fn<Unused>(),
  readBrowserRunForScope,
  saveBrowserProfileId: vi.fn<Unused>(),
  updateBrowserRunProgress: vi.fn<Unused>(),
}));
vi.mock("@db/services/user-profile", () => ({
  readUserProfile: vi.fn<Unused>(),
}));
vi.mock("@agent/lib/browser-use/secrets", () => ({
  resolveBrowserSecretBindings: vi.fn<Unused>(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("browser_task scoping", () => {
  it("refuses an action against a run outside the caller's workspace", async () => {
    const { browserTask } = await import("@agent/tools/browser_task");

    await expect(
      browserTask.execute(
        { action: "status", runId },
        toolContext("better-auth:bob")
      )
    ).rejects.toThrow("That browser run is not part of this workspace.");
    expect(readBrowserRunForScope).toHaveBeenCalledExactlyOnceWith(
      accessScopeForUser("better-auth:bob"),
      runId
    );
  });

  it("requires an authenticated conversation", async () => {
    const { browserTask } = await import("@agent/tools/browser_task");
    const context = toolContext("better-auth:bob");
    const anonymous = {
      ...context,
      session: { ...context.session, auth: { current: null, initiator: null } },
    } satisfies ToolContext;

    await expect(
      browserTask.execute({ action: "status", runId }, anonymous)
    ).rejects.toThrow("An authenticated user is required");
  });
});

function toolContext(principalId: string) {
  return {
    abortSignal: AbortSignal.abort(),
    callId: "call-1",
    getSandbox: () => {
      throw new Error("The tool does not use a sandbox.");
    },
    getSkill: () => {
      throw new Error("The tool does not use a skill.");
    },
    getToken: () => {
      throw new Error("The tool does not use an inline token provider.");
    },
    requireAuth: (): never => {
      throw new Error("The tool does not require an inline token provider.");
    },
    session: {
      auth: {
        current: {
          attributes: {
            conversationChannel: "photon",
            conversationId: "imessage:chat-1",
            workspaceId: accessScopeForUser(principalId).workspaceId,
          },
          authenticator: "photon-imessage",
          issuer: "open-instinct",
          principalId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "browser_task",
  } satisfies ToolContext;
}
