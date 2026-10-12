import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";
import { toolContext } from "@tests/helpers/tool-context";

const agency = vi.hoisted(() => ({
  agencyActionRecorded:
    vi.fn<(workspaceId: string, hash: string) => Promise<boolean>>(),
  agencyBudgetUsage:
    vi.fn<(workspaceId: string, since: Date) => Promise<Map<string, number>>>(),
  beginAgencyAction: vi.fn<() => Promise<{ kind: "started"; id: string }>>(),
  finishAgencyAction: vi.fn<(id: string, status: string) => Promise<boolean>>(),
}));
const profile = vi.hoisted(() => ({
  readUserProfile:
    vi.fn<
      () => Promise<{ addressLine1: null; addressLine2: null; phone: null }>
    >(),
  readWorkspaceTimeZone: vi.fn<() => Promise<string>>(),
}));
const services = vi.hoisted(() => ({
  planOutboundCall: vi.fn<
    () => Promise<{
      created: boolean;
      row: { id: string; state: string };
    }>
  >(),
  startCall:
    vi.fn<() => Promise<{ accepted: boolean; conversationId: string }>>(),
}));

vi.stubEnv("TELEGRAM_BOT_USERNAME", "phone_test_bot");
vi.mock("@db/services/agency", () => agency);
vi.mock("@db/services/user-profile", () => profile);
vi.mock("@db/services/phone", () => ({
  changePhoneState: vi.fn<() => void>(),
  claimCallStart: async () => ({ id: "local-call" }),
  hasEarlierConnectedCall: async () => false,
  listPhoneCalls: vi.fn<() => void>(),
  phonePilot: () => true,
  planOutboundCall: services.planOutboundCall,
  readPhoneNumber: async () => ({
    agentId: "agent",
    number: "+74950000001",
    outboundPhoneNumberId: "outbound",
    sipId: "sip",
  }),
  readPhoneNumberRequest: vi.fn<() => void>(),
  recordCallAccepted: vi.fn<() => void>(),
  recordCallUncertain: vi.fn<() => void>(),
  savePhoneQuote: vi.fn<() => void>(),
}));
vi.mock("@db/services/phone/lifecycle", () => ({
  activatePhone: vi.fn<() => void>(),
  releasePhone: vi.fn<() => void>(),
}));
vi.mock("@shared/phone/exolve", () => ({ quoteNumber: vi.fn<() => void>() }));
vi.mock("@shared/phone/elevenlabs", () => ({
  requirePhoneAgentReady: async () => undefined,
  startCall: services.startCall,
}));

const workerAuth = {
  current: {
    attributes: {
      conversationChannel: "eve",
      conversationId: "web-chat-1",
      scheduledRunKind: "agentic",
      workspaceId: "workspace-1",
    },
    authenticator: "scheduled-worker",
    issuer: "open-instinct",
    principalId: "user-1",
    principalType: "user" as const,
  },
  initiator: null,
};

/** The agentic worker's own turn, in a session no person writes to. */
function workerContext(callId = "call-1") {
  const base = toolContext("phone-call");
  return {
    ...base,
    callId,
    session: {
      auth: workerAuth,
      id: "worker-session",
      turn: { id: "turn-1", sequence: 0 },
    },
  } satisfies ToolContext;
}

/** The `phone-call` tool the step resolver offers this turn, if any. */
async function loadCallTool(pilot: string, context: ToolContext) {
  // The worker's pilot is read from the environment when the modules load.
  vi.resetModules();
  vi.stubEnv("AGENCY_WORKSPACES", pilot);
  const phoneTools = (await import("@agent/tools/phone")).default;
  const messages: ModelMessage[] = [];
  const resolved: DynamicResolveContext = {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: { auth: context.session.auth, id: context.session.id },
  };
  const tools = await phoneTools.events["step.started"]?.({}, resolved);
  const tool = tools && "phone-call" in tools ? tools["phone-call"] : undefined;
  if (!tool) throw new Error("Expected phone-call.");
  return tool;
}

async function decide(
  tool: Awaited<ReturnType<typeof loadCallTool>>,
  context: ToolContext,
  input: { target: string; task: string }
) {
  const policy = tool.approval;
  if (policy === undefined) throw new Error("Expected an approval.");
  const approval = "request" in policy ? policy.request : policy;
  return approval({
    ...context,
    approvedTools: new Set(),
    toolInput: input,
  });
}

function inContext(run: () => Promise<void>) {
  return () => contextStorage.run(new ContextContainer(), run);
}

const target = "+74951234567";
const input = { target, task: "Уточнить, есть ли столик на двоих в 20:00." };
/** A moment on the person's clock in Moscow (UTC+3): 12:00 and 00:30. */
const day = new Date("2026-10-12T09:00:00.000Z");
const night = new Date("2026-10-12T21:30:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(day);
  agency.agencyActionRecorded.mockResolvedValue(false);
  agency.agencyBudgetUsage.mockResolvedValue(new Map());
  agency.beginAgencyAction.mockResolvedValue({ id: "row-1", kind: "started" });
  agency.finishAgencyAction.mockResolvedValue(true);
  profile.readWorkspaceTimeZone.mockResolvedValue("Europe/Moscow");
  profile.readUserProfile.mockResolvedValue({
    addressLine1: null,
    addressLine2: null,
    phone: null,
  });
  services.planOutboundCall.mockResolvedValue({
    created: true,
    row: { id: "local-call", state: "planned" },
  });
  services.startCall.mockResolvedValue({
    accepted: true,
    conversationId: "conversation-1",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.stubEnv("AGENCY_WORKSPACES", "");
  vi.clearAllMocks();
});

// The first case loads the phone tools, which takes seconds under load.
describe("the agentic worker's phone call", { timeout: 30_000 }, () => {
  it(
    "is granted in its pilot, journaled as a call, and placed to the person's chat",
    inContext(async () => {
      const context = workerContext();
      const tool = await loadCallTool("workspace-1", context);
      expect(await decide(tool, context, input)).toBe("not-applicable");

      const result = await tool.execute(input, context);
      expect(result).toMatchObject({ state: "accepted" });
      expect(agency.beginAgencyAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionClass: "call",
          counterparty: target,
          tool: "phone-call",
          workspaceId: "workspace-1",
        })
      );
      expect(agency.finishAgencyAction).toHaveBeenCalledWith(
        "row-1",
        "done",
        null
      );
      // The report goes to the chat the job writes to, not to the worker.
      expect(services.planOutboundCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          conversationChannel: "eve",
          conversationId: "web-chat-1",
          sessionId: "worker-session",
        })
      );
      expect(services.startCall).toHaveBeenCalledTimes(1);
    })
  );

  it(
    "is refused a call in the person's quiet hours",
    inContext(async () => {
      vi.setSystemTime(night);
      const context = workerContext();
      const tool = await loadCallTool("workspace-1", context);
      expect(JSON.stringify(await decide(tool, context, input))).toMatch(
        /quiet hours/u
      );
    })
  );

  it(
    "is refused once the day's call budget is used up",
    inContext(async () => {
      agency.agencyBudgetUsage.mockResolvedValue(new Map([["call", 3]]));
      const context = workerContext();
      const tool = await loadCallTool("workspace-1", context);
      expect(JSON.stringify(await decide(tool, context, input))).toMatch(
        /call actions for today/u
      );
    })
  );

  it(
    "is refused a repeat of a call the journal still holds",
    inContext(async () => {
      agency.agencyActionRecorded.mockResolvedValue(true);
      const context = workerContext();
      const tool = await loadCallTool("workspace-1", context);
      expect(JSON.stringify(await decide(tool, context, input))).toMatch(
        /already taken/u
      );
    })
  );

  it(
    "is refused a call that a background task's turn would place",
    inContext(async () => {
      const context = workerContext();
      const background = {
        ...context,
        session: {
          ...context.session,
          auth: {
            ...workerAuth,
            current: {
              ...workerAuth.current,
              authenticator: "background-task",
            },
          },
        },
      };
      const tool = await loadCallTool("workspace-1", background);
      expect(await decide(tool, background, input)).toMatchObject({
        type: "denied",
      });
      await expect(tool.execute(input, background)).rejects.toThrow(
        /root-user message/u
      );
      expect(agency.beginAgencyAction).not.toHaveBeenCalled();
      expect(services.startCall).not.toHaveBeenCalled();
    })
  );

  it(
    "is refused outside the pilot, as a proactive check is",
    inContext(async () => {
      const context = workerContext();
      const tool = await loadCallTool("workspace-2", context);
      expect(await decide(tool, context, input)).toMatchObject({
        type: "denied",
      });
      await expect(tool.execute(input, context)).rejects.toThrow(
        /root-user message/u
      );
      expect(services.startCall).not.toHaveBeenCalled();
    })
  );
});
