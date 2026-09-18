import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserUseCreateRunInput } from "@agent/lib/browser-use/client";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import { emptyUserProfile } from "@shared/user-profile/schema";

const runId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

const readBrowserRunForScope = vi.hoisted(() =>
  vi.fn<(scope: AccessScope, id: string) => Promise<undefined>>(() =>
    Promise.resolve(undefined)
  )
);
const createBrowserUseRun = vi.hoisted(() =>
  vi.fn<
    (input: BrowserUseCreateRunInput) => Promise<{
      id: string;
      model: string;
      sessionId: string;
      status: string;
    }>
  >()
);

type Unused = () => never;

vi.mock("@db/services/browser-runs", () => ({
  claimBrowserRunCompletion: vi.fn<Unused>(),
  createBrowserRun: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  readBrowserProfileId: vi.fn<() => Promise<string>>(() =>
    Promise.resolve("profile-1")
  ),
  readBrowserRunForScope,
  saveBrowserProfileId: vi.fn<Unused>(),
  updateBrowserRunProgress: vi.fn<Unused>(),
}));
vi.mock("@db/services/user-profile", () => ({
  readUserProfile: vi.fn<() => Promise<typeof emptyUserProfile>>(() =>
    Promise.resolve(emptyUserProfile)
  ),
}));
vi.mock("@agent/lib/browser-use/secrets", () => ({
  resolveBrowserSecretBindings: vi.fn<
    () => Promise<{ aliases: string[]; bindings: [] }>
  >(() => Promise.resolve({ aliases: [], bindings: [] })),
}));
vi.mock("@agent/lib/browser-use/client", () => ({
  browserUseConfigured: vi.fn<() => boolean>(() => true),
  cancelBrowserUseRun: vi.fn<Unused>(),
  createBrowserUseProfile: vi.fn<Unused>(),
  createBrowserUseRun,
  // The live-view lookup gives up on the first failure, which keeps the start
  // path from waiting out its full poll budget here.
  listBrowserUseRunEvents: vi.fn<() => Promise<never>>(() =>
    Promise.reject(new Error("no events in this test"))
  ),
  liveViewUrlFromEvents: vi.fn<Unused>(),
  queueBrowserUseSessionMessage: vi.fn<Unused>(),
  readBrowserUseRunStatus: vi.fn<Unused>(),
}));

afterEach(() => {
  vi.stubEnv("BROWSER_USE_MAX_COST_USD", "");
  vi.clearAllMocks();
});

async function startErrand(maxCostUsd: string) {
  vi.resetModules();
  vi.stubEnv("BROWSER_USE_MAX_COST_USD", maxCostUsd);
  createBrowserUseRun.mockResolvedValue({
    id: runId,
    model: "hosted-agent",
    sessionId,
    status: "running",
  });
  const { browserTask } = await import("@agent/tools/browser_task");
  return browserTask.execute(
    { action: "start", site: "https://example.com", task: "Order the usual" },
    toolContext("better-auth:alice")
  );
}

describe("browser_task cost ceiling", () => {
  it("creates every run with the deployment's ceiling", async () => {
    await startErrand("");

    expect(createBrowserUseRun).toHaveBeenCalledOnce();
    expect(createBrowserUseRun.mock.calls[0]?.[0].maxCostUsd).toBe(1);
  });

  it("honours an overridden ceiling", async () => {
    await startErrand("2.5");

    expect(createBrowserUseRun).toHaveBeenCalledOnce();
    expect(createBrowserUseRun.mock.calls[0]?.[0].maxCostUsd).toBe(2.5);
  });
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
