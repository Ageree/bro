import type { DynamicResolveContext } from "eve";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ModelSelection from "@agent/lib/model/selection";
import type { readWorkspaceScope } from "@db/services/scope";
import type {
  getFormOfAddress,
  getWorkspaceModelId,
} from "@db/services/settings";
import type { readWorkspaceTimeZone } from "@db/services/user-profile";
import type { readAccountEmail } from "@db/services/users";
import { defaultFormOfAddress } from "@shared/chat/form-of-address";

const services = vi.hoisted(() => ({
  browserRunReportDelivered: vi.fn<(runId: string) => Promise<boolean>>(),
  getFormOfAddress: vi.fn<typeof getFormOfAddress>(),
  getModel: vi.fn<typeof getWorkspaceModelId>(),
  modelSelection: vi.fn<typeof ModelSelection.modelSelection>(),
  readAccountEmail: vi.fn<typeof readAccountEmail>(),
  readWorkspaceScope: vi.fn<typeof readWorkspaceScope>(),
  readWorkspaceTimeZone: vi.fn<typeof readWorkspaceTimeZone>(),
}));

vi.mock("@db/services/browser-runs", () => ({
  browserRunReportDelivered: services.browserRunReportDelivered,
}));
vi.mock("@db/services/scheduled-agent-run-leases", () => ({
  isScheduledAgentRunLeaseActive: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("@db/services/settings", () => ({
  getFormOfAddress: services.getFormOfAddress,
  getWorkspaceModelId: services.getModel,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: services.readWorkspaceTimeZone,
}));
vi.mock("@db/services/users", () => ({
  readAccountEmail: services.readAccountEmail,
}));
vi.mock("@db/services/scope", () => ({
  readWorkspaceScope: services.readWorkspaceScope,
}));
vi.mock("@agent/lib/model/selection", () => ({
  modelSelection: services.modelSelection,
}));

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

beforeEach(() => {
  vi.clearAllMocks();
  services.getModel.mockResolvedValue("deepseek/deepseek-v4.1-flash");
  services.getFormOfAddress.mockResolvedValue(defaultFormOfAddress);
  services.browserRunReportDelivered.mockResolvedValue(false);
  services.readWorkspaceTimeZone.mockResolvedValue("Asia/Vladivostok");
  services.readAccountEmail.mockResolvedValue("Alice@Example.com");
  services.readWorkspaceScope.mockResolvedValue({
    userId: "user-1",
    workspaceId,
  });
  services.modelSelection.mockReturnValue("deepseek/deepseek-v4.1-flash");
});

/** The provider settings a case may set; the rest stay unset. */
const providerSettings = [
  "MODEL_PROVIDER",
  "OPENROUTER_API_KEY",
  "ROUTERAI_API_KEY",
] as const;

type ProviderSettings = Partial<
  Record<(typeof providerSettings)[number], string>
>;

afterEach(() => {
  for (const name of providerSettings) vi.stubEnv(name, "");
  vi.stubEnv("STEP_CONTEXT_WORKSPACES", "");
});

/** Loads `load` against a fresh environment with these settings. */
async function withSettings<T>(
  settings: ProviderSettings & { STEP_CONTEXT_WORKSPACES?: string },
  load: () => Promise<T>
) {
  vi.resetModules();
  for (const name of providerSettings) vi.stubEnv(name, settings[name] ?? "");
  vi.stubEnv("STEP_CONTEXT_WORKSPACES", settings.STEP_CONTEXT_WORKSPACES ?? "");
  return load();
}

const openRouter = { OPENROUTER_API_KEY: "openrouter-test-key" };

async function pilot(list?: string, settings: ProviderSettings = openRouter) {
  const { stepContextPilot } = await withSettings(
    { ...settings, STEP_CONTEXT_WORKSPACES: list },
    async () => import("@agent/lib/step-context/pilot")
  );
  return stepContextPilot({ workspaceId });
}

describe("the pilot list of the cache-friendly step", () => {
  it("names nobody while unset, and nobody on the Gateway", async () => {
    expect(await pilot()).toBe(false);
    expect(await pilot("*", {})).toBe(false);
    expect(await pilot(workspaceId, {})).toBe(false);
    expect(services.readAccountEmail).not.toHaveBeenCalled();
  });

  it("names a workspace by id or by its owner's email, or everyone by *", async () => {
    expect(await pilot("*")).toBe(true);
    expect(
      await pilot("*", {
        MODEL_PROVIDER: "routerai",
        ROUTERAI_API_KEY: "routerai-test-key",
      })
    ).toBe(true);
    expect(await pilot(` other , ${workspaceId} `)).toBe(true);
    expect(await pilot("someone@example.com, alice@example.COM")).toBe(true);
    expect(await pilot("someone@example.com, other")).toBe(false);
  });

  it("looks the owner's email up once, and keeps a failed lookup out", async () => {
    const { stepContextPilot } = await withSettings(
      { ...openRouter, STEP_CONTEXT_WORKSPACES: "alice@example.com" },
      async () => import("@agent/lib/step-context/pilot")
    );
    services.readAccountEmail.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await stepContextPilot({ workspaceId })).toBe(false);
    expect(await stepContextPilot({ workspaceId })).toBe(true);
    expect(await stepContextPilot({ workspaceId })).toBe(true);
    expect(services.readAccountEmail).toHaveBeenCalledTimes(2);
  });
});

describe("a step in the pilot", () => {
  async function loadAgent(list?: string) {
    return withSettings(
      { ...openRouter, STEP_CONTEXT_WORKSPACES: list },
      async () => (await import("@agent/agent")).default
    );
  }

  async function stepOptions(
    list: string | undefined,
    context: DynamicResolveContext
  ) {
    const agent = await loadAgent(list);
    await agent.model.events["step.started"]?.({}, context);
    const [, options] = services.modelSelection.mock.lastCall ?? [];
    return options;
  }

  it("carries the clock in the step's note, not in the turn's instructions", async () => {
    const options = await stepOptions(
      "*",
      interactiveContext([humanMessage("что у меня завтра?")])
    );

    expect(options?.stableContext).toBe(true);
    expect(options?.replyNote).toMatch(
      /^Сейчас у человека .*Asia\/Vladivostok/u
    );
    expect(services.readWorkspaceTimeZone).toHaveBeenCalledExactlyOnceWith({
      userId: "user-1",
      workspaceId,
    });
    expect(options?.offeredTools).toBeUndefined();
  });

  it("builds the step as before outside the pilot", async () => {
    const options = await stepOptions(
      "someone-else",
      interactiveContext([humanMessage("что у меня завтра?")])
    );

    expect(options).not.toHaveProperty("stableContext");
    expect(options).not.toHaveProperty("offeredTools");
    expect(options?.replyNote).not.toContain("Сейчас у человека");
    expect(services.readWorkspaceTimeZone).not.toHaveBeenCalled();
  });

  it("gives a browser report's turn only its few tools once the message is out", async () => {
    const { cardToolsBeforeOutcome, reportToolsAfterOutcome, stepsAskedBy } =
      await import("@agent/lib/delivery/browser-report");
    const report = [humanMessage("Browser run finished")];

    // Before the message nothing changes: the cards wait as they did.
    const before = await stepOptions(
      "*",
      interactiveContext(report, "browser-result", reportAttributes)
    );
    expect(before?.offeredTools).toBeUndefined();
    expect(before?.withheldTools).toEqual([
      "ask_question",
      ...cardToolsBeforeOutcome,
      "task",
    ]);

    const after = await stepOptions(
      "*",
      interactiveContext(
        [...report, ...sent("call-1", "Записал на 3 октября, 14:30.")],
        "browser-result",
        reportAttributes
      )
    );
    expect(after?.offeredTools).toEqual(reportToolsAfterOutcome);
    expect(after?.withheldTools).toEqual(["ask_question", "task"]);
    // Every card step a report may ask for, and the sign-in the calendar's
    // refusal names when Google is not connected.
    const { googleNotConnectedWriteRefusal } =
      await import("@agent/lib/google-workspace/client");
    const { calendarInstruction, laterStepInstruction } =
      await import("@agent/lib/browser-use/guidance");
    const owed = stepsAskedBy(
      `Result: booked.\n\n${calendarInstruction} ${laterStepInstruction}`
    ).map(({ tool }) => tool);
    expect(owed).toEqual(["calendar-create-event", "schedules-create"]);
    expect(googleNotConnectedWriteRefusal).toContain("connect_google");
    expect(reportToolsAfterOutcome).toEqual(
      expect.arrayContaining([...owed, "connect_google", "send_message"])
    );

    // Outside the pilot the turn keeps every tool after its message.
    const outside = await stepOptions(
      undefined,
      interactiveContext(
        [...report, ...sent("call-1", "Записал на 3 октября, 14:30.")],
        "browser-result",
        reportAttributes
      )
    );
    expect(outside).not.toHaveProperty("offeredTools");
  });

  it("keeps a person's turn on every tool after its reply", async () => {
    const options = await stepOptions(
      "*",
      interactiveContext([humanMessage("привет"), ...sent("call-1", "Привет!")])
    );

    expect(options?.stableContext).toBe(true);
    expect(options?.offeredTools).toBeUndefined();
  });
});

describe("the local time instruction in the pilot", () => {
  async function instruction(list: string | undefined, authenticator: string) {
    const localTime = await withSettings(
      { ...openRouter, STEP_CONTEXT_WORKSPACES: list },
      async () => (await import("@agent/instructions/50-local-time")).default
    );
    return localTime.events["turn.started"]?.(
      {},
      interactiveContext([], authenticator)
    );
  }

  it("explains the step note instead of telling the time", async () => {
    const { stepNoteInstructions } =
      await import("@agent/lib/step-context/note");
    const selected = await instruction("*", "authjs");

    expect(selected?.content).toContain(stepNoteInstructions);
    expect(selected?.content).toContain("personal_info__update");
    expect(selected?.content).not.toContain("Сейчас у человека");
    expect(services.readWorkspaceTimeZone).not.toHaveBeenCalled();

    const report = await instruction("*", "scheduled-result");
    expect(report?.content).toBe(stepNoteInstructions);
  });

  it("tells the time as before outside the pilot", async () => {
    const selected = await instruction(undefined, "authjs");

    expect(selected?.content).toContain("Asia/Vladivostok");
    expect(selected?.content).not.toContain("bro-step-note");
  });
});

/** Every browser report carries the run it reports. */
const reportAttributes = { browserRunId: "browser-run-1", workspaceId };

function humanMessage(text: string) {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

/** A `send_message` call of the turn that reached the person. */
function sent(id: string, text: string) {
  return [
    {
      content: [
        {
          input: { kind: "message", text },
          toolCallId: id,
          toolName: "send_message",
          type: "tool-call" as const,
        },
      ],
      role: "assistant" as const,
    },
    {
      content: [
        {
          output: { type: "text" as const, value: "submitted" },
          toolCallId: id,
          toolName: "send_message",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
  ];
}

function interactiveContext(
  messages: DynamicResolveContext["messages"],
  authenticator = "authjs",
  attributes: Readonly<Record<string, string>> = { workspaceId }
): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve" },
    messages,
    model: null,
    session: {
      auth: {
        current: {
          attributes,
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "interactive-session",
    },
  };
}
