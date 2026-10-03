import { afterEach, describe, expect, it, vi } from "vitest";
import type { readWorkspaceScope } from "@db/services/scope";
import type { readAccountEmail } from "@db/services/users";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

const services = vi.hoisted(() => ({
  readAccountEmail: vi.fn<typeof readAccountEmail>(),
  readWorkspaceScope: vi.fn<typeof readWorkspaceScope>(),
}));

vi.mock("@db/services/users", () => ({
  readAccountEmail: services.readAccountEmail,
}));
vi.mock("@db/services/scope", () => ({
  readWorkspaceScope: services.readWorkspaceScope,
}));

afterEach(() => {
  clearSandboxSettings();
  vi.clearAllMocks();
  vi.resetModules();
});

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

describe("the task agent's pilot", () => {
  it("looks the owner's email up once for many steps, and keeps a failed lookup out", async () => {
    services.readAccountEmail.mockResolvedValue("Alice@Example.com");
    services.readAccountEmail.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { taskAgentPilot } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      {
        OPENROUTER_API_KEY: "openrouter-test-key",
        SANDBOX_WORKSPACES: "alice@example.com",
      }
    );

    const scope = { userId: "user-1", workspaceId };
    expect(await taskAgentPilot(scope)).toBe(false);
    expect(await taskAgentPilot(scope)).toBe(true);
    expect(await taskAgentPilot(scope)).toBe(true);
    expect(await taskAgentPilot(scope)).toBe(true);
    expect(services.readAccountEmail).toHaveBeenCalledTimes(2);
  });

  it("runs on RouterAI as on OpenRouter", async () => {
    const { taskAgentPilot } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      {
        MODEL_PROVIDER: "routerai",
        ROUTERAI_API_KEY: "routerai-test-key",
        SANDBOX_WORKSPACES: "*",
      }
    );
    expect(await taskAgentPilot({ workspaceId })).toBe(true);
  });

  it("names nobody on the Gateway, whatever the list says", async () => {
    const { taskAgentPilot } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      { SANDBOX_WORKSPACES: "*" }
    );
    expect(await taskAgentPilot({ workspaceId })).toBe(false);
  });
});

describe("the pilot of the person's files", () => {
  const filesPilot = {
    OPENROUTER_API_KEY: "openrouter-test-key",
    SANDBOX_WORKSPACES: workspaceId,
    TASK_FILES_WORKSPACES: workspaceId,
  };

  async function enabled(overrides: Readonly<Record<string, string>>) {
    const { taskFilesEnabled } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      { ...filesPilot, ...overrides }
    );
    return taskFilesEnabled(workspaceId);
  }

  it("names the workspaces both lists name by id or `*`", async () => {
    expect(await enabled({})).toBe(true);
    expect(
      await enabled({ SANDBOX_WORKSPACES: "*", TASK_FILES_WORKSPACES: "*" })
    ).toBe(true);
    expect(await enabled({ TASK_FILES_WORKSPACES: "" })).toBe(false);
    expect(await enabled({ TASK_FILES_WORKSPACES: "personal:other" })).toBe(
      false
    );
    expect(await enabled({ SANDBOX_WORKSPACES: "" })).toBe(false);
    expect(services.readAccountEmail).not.toHaveBeenCalled();
  });

  it("leaves out a task agent's pilot named only by the owner's email", async () => {
    services.readAccountEmail.mockResolvedValue("alice@example.com");
    expect(await enabled({ SANDBOX_WORKSPACES: "alice@example.com" })).toBe(
      false
    );
    expect(services.readAccountEmail).not.toHaveBeenCalled();
  });

  it("needs the code sandbox host, the direct model and Object Storage", async () => {
    expect(await enabled({ SANDBOX_HOST_ORIGIN: "" })).toBe(false);
    expect(await enabled({ OPENROUTER_API_KEY: "" })).toBe(false);
    expect(await enabled({ CLOUDRU_KEY_SECRET: "" })).toBe(false);
  });

  it("asks for the workspace of the person or of Bro's own caller", async () => {
    const { taskFilesOfCaller } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      filesPilot
    );
    const person = {
      attributes: { workspaceId },
      authenticator: "telegram-webhook",
      principalId: "user-1",
      principalType: "user" as const,
    };

    expect(
      taskFilesOfCaller({
        session: { auth: { current: person, initiator: null } },
      })
    ).toBe(true);
    expect(
      taskFilesOfCaller({
        session: { auth: { current: null, initiator: person } },
      })
    ).toBe(true);
    expect(
      taskFilesOfCaller({
        session: {
          auth: {
            current: {
              ...person,
              attributes: { workspaceId: "personal:other" },
            },
            initiator: null,
          },
        },
      })
    ).toBe(false);
    expect(
      taskFilesOfCaller({
        session: {
          auth: { current: { ...person, attributes: {} }, initiator: null },
        },
      })
    ).toBe(false);
    expect(
      taskFilesOfCaller({
        session: { auth: { current: null, initiator: null } },
      })
    ).toBe(false);
  });

  it("takes no emails in the list", async () => {
    await expect(
      importWithSandbox(async () => await import("@agent/lib/sandbox/pilot"), {
        ...filesPilot,
        TASK_FILES_WORKSPACES: "alice@example.com",
      })
    ).rejects.toThrow(/Invalid environment variables/u);
  });
});

/** Object Storage answering the GETs of marks in turn. */
function stubMarks(...answers: readonly Response[]) {
  const keys: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    keys.push(decodeURIComponent(new URL(url).pathname));
    const answer = answers[keys.length - 1];
    return answer === undefined
      ? Promise.reject(new Error("The test ran out of stubbed answers."))
      : Promise.resolve(answer);
  });
  return keys;
}

describe("a conversation that may hold the person's files", () => {
  const person = {
    attributes: { workspaceId },
    authenticator: "telegram-webhook",
    principalId: "user-1",
    principalType: "user" as const,
  };
  const conversation = {
    session: { auth: { current: person, initiator: null }, id: "session-1" },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("holds them by the mark of one of its task agents once the files pilot is cleared", async () => {
    const keys = stubMarks(
      new Response("1", {
        headers: { "last-modified": new Date().toUTCString() },
        status: 200,
      })
    );
    const { conversationHoldsFiles, taskFilesGuarded } =
      await importWithSandbox(
        async () => await import("@agent/lib/sandbox/pilot"),
        { OPENROUTER_API_KEY: "openrouter-test-key", SANDBOX_WORKSPACES: "*" }
      );

    expect(taskFilesGuarded()).toBe(true);
    expect(await conversationHoldsFiles(conversation)).toBe(true);
    expect(keys).toEqual([
      expect.stringMatching(
        /^\/bro-state-test\/sandbox\/person-files-conversations\/[\da-f]{16}\/[\da-f]{16}$/u
      ),
    ]);
  });

  it("holds none without the mark, and counts an unreadable mark as there", async () => {
    stubMarks(
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      new Response(null, { status: 403 })
    );
    const { conversationHoldsFiles } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      { OPENROUTER_API_KEY: "openrouter-test-key", SANDBOX_WORKSPACES: "*" }
    );

    expect(await conversationHoldsFiles(conversation)).toBe(false);
    expect(await conversationHoldsFiles(conversation)).toBe(true);
  });

  it("reads no mark for a workspace outside the task agent's pilot", async () => {
    // Every Telegram send asks: only the pilot ever had a helper to give
    // files to, so nobody else's send waits on Object Storage.
    const keys = stubMarks();
    const { conversationHoldsFiles } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      {
        OPENROUTER_API_KEY: "openrouter-test-key",
        SANDBOX_WORKSPACES: "personal:someone-else",
      }
    );

    expect(await conversationHoldsFiles(conversation)).toBe(false);
    expect(keys).toEqual([]);
  });

  it("holds them wherever the files pilot is on, and none without Object Storage", async () => {
    const keys = stubMarks();
    const on = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      {
        OPENROUTER_API_KEY: "openrouter-test-key",
        SANDBOX_WORKSPACES: workspaceId,
        TASK_FILES_WORKSPACES: workspaceId,
      }
    );
    expect(await on.conversationHoldsFiles(conversation)).toBe(true);
    clearSandboxSettings();
    const off = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      { BROWSER_STATE_BUCKET: "", SANDBOX_WORKSPACES: "*" }
    );
    expect(off.taskFilesGuarded()).toBe(false);
    expect(await off.conversationHoldsFiles(conversation)).toBe(false);
    expect(keys).toEqual([]);
  });
});
