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

/**
 * What Object Storage was asked: the listing of the workspace's
 * conversations' marks, a GET or PUT of the conversation's mark by its
 * hashed key, or the key.
 */
function askedFor(method: string, url: URL) {
  const key = decodeURIComponent(url.pathname);
  if (
    key === "/bro-state-test" &&
    url.searchParams.get("list-type") === "2" &&
    url.searchParams.get("max-keys") === "1" &&
    /^sandbox\/person-files-conversations\/[\da-f]{16}\/$/u.test(
      url.searchParams.get("prefix") ?? ""
    )
  ) {
    return "LIST workspace";
  }
  if (
    /^\/bro-state-test\/sandbox\/person-files-conversations\/[\da-f]{16}\/[\da-f]{16}$/u.test(
      key
    )
  ) {
    return `${method} conversation`;
  }
  return `${method} ${key}`;
}

/**
 * Object Storage holding the marks named: this conversation's, another
 * conversation's of the same workspace, or answering every request with
 * `failing`. Only conversations are marked, as every release did.
 */
function stubMarks(
  held: {
    readonly conversation?: boolean;
    readonly otherConversation?: boolean;
  },
  failing?: number
) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const asked = askedFor(method, parsed);
    calls.push(asked);
    if (failing !== undefined) {
      return Promise.resolve(new Response(null, { status: failing }));
    }
    if (asked === "LIST workspace") {
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const keys = [
        ...(held.conversation === true ? [`${prefix}${"a".repeat(16)}`] : []),
        ...(held.otherConversation === true
          ? [`${prefix}${"b".repeat(16)}`]
          : []),
      ].slice(0, 1);
      return Promise.resolve(
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bro-state-test</Name><Prefix>${prefix}</Prefix><KeyCount>${String(keys.length)}</KeyCount><MaxKeys>1</MaxKeys>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
          { status: 200 }
        )
      );
    }
    const there =
      method === "PUT" ||
      (asked === "GET conversation" && held.conversation === true);
    return Promise.resolve(
      there
        ? new Response("1", {
            headers: { "last-modified": new Date().toUTCString() },
            status: 200,
          })
        : new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
          })
    );
  });
  return calls;
}

const workspaceMark = "LIST workspace";
const conversationMark = "GET conversation";

async function loadPilot(overrides: Readonly<Record<string, string>>) {
  return await importWithSandbox(
    async () => await import("@agent/lib/sandbox/pilot"),
    overrides
  );
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
  const taskAgentPilot = {
    OPENROUTER_API_KEY: "openrouter-test-key",
    SANDBOX_WORKSPACES: "*",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("holds them by the marks once the files pilot is cleared", async () => {
    const calls = stubMarks({ conversation: true });
    const { conversationHoldsFiles, taskFilesGuarded } =
      await loadPilot(taskAgentPilot);

    expect(taskFilesGuarded()).toBe(true);
    expect(await conversationHoldsFiles(conversation)).toBe(true);
    expect(calls).toEqual([workspaceMark, conversationMark]);
  });

  it.each([
    [
      "left the task agent's pilot",
      { ...taskAgentPilot, SANDBOX_WORKSPACES: "personal:someone-else" },
    ],
    ["went to the Gateway", { SANDBOX_WORKSPACES: "*" }],
    [
      "is named by an email that cannot be looked up",
      { ...taskAgentPilot, SANDBOX_WORKSPACES: "alice@example.com" },
    ],
  ])(
    "holds them by the marks when the workspace %s",
    async (_case, settings) => {
      // The files' content stays in the history whatever the pilots say.
      services.readAccountEmail.mockRejectedValue(new Error("db down"));
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      stubMarks({ conversation: true });
      const { conversationHoldsFiles } = await loadPilot(settings);

      expect(await conversationHoldsFiles(conversation)).toBe(true);
      expect(services.readAccountEmail).not.toHaveBeenCalled();
    }
  );

  it("holds none in a workspace whose conversations were never marked", async () => {
    const calls = stubMarks({});
    const { conversationHoldsFiles } = await loadPilot(taskAgentPilot);

    expect(await conversationHoldsFiles(conversation)).toBe(false);
    // The listing of the workspace's marks is the only request.
    expect(calls).toEqual([workspaceMark]);
  });

  it("holds none in another conversation of a marked workspace", async () => {
    const calls = stubMarks({ otherConversation: true });
    const { conversationHoldsFiles } = await loadPilot(taskAgentPilot);

    expect(await conversationHoldsFiles(conversation)).toBe(false);
    expect(calls).toEqual([workspaceMark, conversationMark]);
  });

  it("holds them by a conversation's mark alone once the files flag is off", async () => {
    // The owner's setup: Object Storage configured, TASK_FILES_WORKSPACES
    // cleared, and only the conversation's mark the releases before the
    // workspace's check wrote. No object of the workspace's is asked for.
    const calls = stubMarks({ conversation: true });
    const { conversationHoldsFiles, reportTurnHoldsFiles } = await loadPilot({
      OPENROUTER_API_KEY: "openrouter-test-key",
      SANDBOX_WORKSPACES: workspaceId,
    });

    expect(await conversationHoldsFiles(conversation)).toBe(true);
    expect(await reportTurnHoldsFiles(conversation)).toBe(true);
    expect(calls).toEqual([workspaceMark, conversationMark]);
  });

  it("asks a workspace that never gave a task agent a file once in a few seconds", async () => {
    // Every Telegram send of every workspace asks.
    vi.useFakeTimers();
    const calls = stubMarks({});
    const { conversationHoldsFiles } = await loadPilot({});

    for (const id of ["session-1", "session-2", "session-1"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Sends follow each other.
      const holds = await conversationHoldsFiles({
        session: { ...conversation.session, id },
      });
      expect(holds).toBe(false);
    }
    expect(calls).toEqual([workspaceMark]);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await conversationHoldsFiles(conversation)).toBe(false);
    expect(calls).toEqual([workspaceMark, workspaceMark]);
  });

  it("holds them while the marks cannot be read, in the owner's setup, and asks again after a minute", async () => {
    // Object Storage configured, the task agent's pilot by the owner's
    // email, TASK_FILES_WORKSPACES off, and Object Storage failing.
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    services.readAccountEmail.mockResolvedValue("alice@example.com");
    const calls = stubMarks({}, 503);
    const { conversationHoldsFiles } = await loadPilot({
      OPENROUTER_API_KEY: "openrouter-test-key",
      SANDBOX_WORKSPACES: "alice@example.com",
    });

    const first = conversationHoldsFiles(conversation);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe(true);
    // The try and its retry, then nothing for a minute.
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await conversationHoldsFiles(conversation)).toBe(true);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    const later = conversationHoldsFiles(conversation);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await later).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it("holds them wherever the files pilot is on, reading no mark", async () => {
    const calls = stubMarks({});
    const { conversationHoldsFiles } = await loadPilot({
      OPENROUTER_API_KEY: "openrouter-test-key",
      SANDBOX_WORKSPACES: workspaceId,
      TASK_FILES_WORKSPACES: workspaceId,
    });

    expect(await conversationHoldsFiles(conversation)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("holds none without Object Storage, but a report turn's sends carry none", async () => {
    const calls = stubMarks({ conversation: true });
    const { conversationHoldsFiles, reportTurnHoldsFiles, taskFilesGuarded } =
      await loadPilot({ ...taskAgentPilot, BROWSER_STATE_BUCKET: "" });

    expect(taskFilesGuarded()).toBe(false);
    expect(await conversationHoldsFiles(conversation)).toBe(false);
    expect(await reportTurnHoldsFiles(conversation)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("asks a report turn's conversation its marks where Object Storage is", async () => {
    stubMarks({});
    const { reportTurnHoldsFiles } = await loadPilot(taskAgentPilot);

    expect(await reportTurnHoldsFiles(conversation)).toBe(false);
  });
});
