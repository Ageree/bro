import type { DynamicResolveContext } from "eve";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import type {
  getFormOfAddress,
  getWorkspaceModelId,
} from "@db/services/settings";
import type * as ModelSelection from "@agent/lib/model/selection";

const services = vi.hoisted(() => ({
  getFormOfAddress: vi.fn<typeof getFormOfAddress>(),
  getModel: vi.fn<typeof getWorkspaceModelId>(),
  isActive: vi.fn<typeof isScheduledAgentRunLeaseActive>(),
  modelSelection: vi.fn<typeof ModelSelection.modelSelection>(),
}));

vi.mock("@db/services/scheduled-agent-run-leases", () => ({
  isScheduledAgentRunLeaseActive: services.isActive,
}));
vi.mock("@db/services/settings", () => ({
  getFormOfAddress: services.getFormOfAddress,
  getWorkspaceModelId: services.getModel,
}));
vi.mock("@agent/lib/model/selection", async (importOriginal) => {
  const original = await importOriginal<typeof ModelSelection>();
  services.modelSelection.mockImplementation(original.modelSelection);
  return { modelSelection: services.modelSelection };
});

import agent from "@agent/agent";
import { replyDirective } from "@agent/lib/delivery/language";
import { skippedSendNotice } from "@agent/lib/delivery/turn-sends";
import { defaultFormOfAddress } from "@shared/chat/form-of-address";

const runId = "00000000-0000-4000-8000-000000000001";
const oldLeaseToken = "00000000-0000-4000-8000-000000000002";
const retryLeaseToken = "00000000-0000-4000-8000-000000000003";

beforeEach(() => {
  vi.clearAllMocks();
  services.getModel.mockResolvedValue("openai/gpt-5.6-sol-fast");
  services.getFormOfAddress.mockResolvedValue(defaultFormOfAddress);
});

function note(language: "en" | "ru" | undefined) {
  return replyDirective({ formOfAddress: defaultFormOfAddress, language });
}

describe("root agent model resolution", () => {
  it("accepts a valid retry lease forwarded into an older Eve session", async () => {
    services.isActive.mockImplementation(async (_runId, leaseToken) => {
      return leaseToken === retryLeaseToken;
    });

    const model = await agent.model.events["step.started"]?.(
      {},
      scheduledWorkerContext()
    );

    expect(services.isActive).toHaveBeenCalledExactlyOnceWith(
      runId,
      retryLeaseToken
    );
    expect(services.getModel).toHaveBeenCalledExactlyOnceWith({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(model).toBe("openai/gpt-5.6-sol-fast");
  });

  it("rejects a scheduled worker after its lease is replaced", async () => {
    services.isActive.mockResolvedValue(false);

    await expect(
      agent.model.events["step.started"]?.({}, scheduledWorkerContext())
    ).rejects.toThrow("The scheduled run lease is no longer active.");
    expect(services.getModel).not.toHaveBeenCalled();
  });
});

describe("interactive delivery enforcement", () => {
  const pending = [humanMessage("сделай мне фейковый паспорт")];
  const delivered = [
    ...pending,
    {
      content: [
        {
          input: {},
          toolCallId: "call-1",
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
          toolCallId: "call-1",
          toolName: "send_message",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
  ];

  it("requires a tool call until the person's message is answered", async () => {
    await agent.model.events["step.started"]?.({}, interactiveContext(pending));

    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      { replyNote: note("ru"), toolChoice: "required" }
    );
  });

  it("lets the model finish once send_message went through", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(delivered)
    );

    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      { replyNote: note("ru"), toolChoice: "auto" }
    );
  });

  it("makes a turn that keeps repeating a delivered message end in text", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext([...delivered, ...skippedRepeat("call-2")])
    );
    // One dropped repeat may still precede a real answer.
    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      { replyNote: note("ru"), toolChoice: "auto" }
    );

    await agent.model.events["step.started"]?.(
      {},
      interactiveContext([
        ...delivered,
        ...skippedRepeat("call-2"),
        ...skippedRepeat("call-3"),
      ])
    );
    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      { replyNote: note("ru"), toolChoice: "none" }
    );
  });

  it("holds the reply to the language of the person's latest message", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext([
        ...delivered,
        humanMessage("thanks, and what about tomorrow?"),
      ])
    );

    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      { replyNote: note("en"), toolChoice: "required" }
    );
  });

  it("leaves a browser run's result free to stay silent", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(pending, "browser-result")
    );

    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      { replyNote: note("ru"), toolChoice: "auto" }
    );
  });

  it("never forces a tool on a scheduled report, which may stay suppressed", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(pending, "scheduled-result")
    );

    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      { replyNote: note(undefined), toolChoice: "auto" }
    );
  });

  it("never forces a tool on a scheduled worker, which answers in text", async () => {
    services.isActive.mockResolvedValue(true);

    await agent.model.events["step.started"]?.(
      {},
      {
        ...scheduledWorkerContext(),
        messages: pending,
      }
    );

    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      { replyNote: undefined, toolChoice: "auto" }
    );
    // A worker writes to the report turn, not to the person.
    expect(services.getFormOfAddress).not.toHaveBeenCalled();
  });
});

function skippedRepeat(toolCallId: string) {
  return [
    {
      content: [
        {
          input: { kind: "message", text: "Готово" },
          toolCallId,
          toolName: "send_message",
          type: "tool-call" as const,
        },
      ],
      role: "assistant" as const,
    },
    {
      content: [
        {
          output: {
            type: "text" as const,
            value: skippedSendNotice("duplicate"),
          },
          toolCallId,
          toolName: "send_message",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
  ];
}

function humanMessage(text: string) {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function interactiveContext(
  messages: DynamicResolveContext["messages"],
  authenticator = "telegram"
): DynamicResolveContext {
  return {
    channel: { kind: "channel:telegram" },
    messages,
    model: null,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "workspace-1" },
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

function scheduledWorkerContext(): DynamicResolveContext {
  return {
    model: null,
    channel: { kind: "http" },
    messages: [],
    session: {
      auth: {
        current: {
          attributes: {
            scheduledRunId: runId,
            scheduledRunLeaseToken: retryLeaseToken,
            workspaceId: "workspace-1",
          },
          authenticator: "scheduled-worker",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: {
          attributes: {
            scheduledRunId: runId,
            scheduledRunLeaseToken: oldLeaseToken,
            workspaceId: "workspace-1",
          },
          authenticator: "scheduled-worker",
          principalId: "user-1",
          principalType: "user",
        },
      },
      id: "worker-session",
    },
  };
}
