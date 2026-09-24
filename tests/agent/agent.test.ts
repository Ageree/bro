import type { DynamicResolveContext } from "eve";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import type {
  getFormOfAddress,
  getWorkspaceModelId,
} from "@db/services/settings";
import type * as ModelSelection from "@agent/lib/model/selection";

const services = vi.hoisted(() => ({
  browserRunReportDelivered: vi.fn<(runId: string) => Promise<boolean>>(),
  getFormOfAddress: vi.fn<typeof getFormOfAddress>(),
  getModel: vi.fn<typeof getWorkspaceModelId>(),
  isActive: vi.fn<typeof isScheduledAgentRunLeaseActive>(),
  modelSelection: vi.fn<typeof ModelSelection.modelSelection>(),
}));

vi.mock("@db/services/scheduled-agent-run-leases", () => ({
  isScheduledAgentRunLeaseActive: services.isActive,
}));
vi.mock("@db/services/browser-runs", () => ({
  browserRunReportDelivered: services.browserRunReportDelivered,
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
  services.browserRunReportDelivered.mockResolvedValue(false);
});

function note(language: "en" | "ru" | undefined, answered = false) {
  return replyDirective({
    answered,
    formOfAddress: defaultFormOfAddress,
    language,
  });
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
          input: { kind: "message", text: "С этим не помогу." },
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
      {
        delivered: false,
        replyNote: note("ru"),
        toolChoice: "required",
        withheldTools: [],
      }
    );
  });

  it("lets the model finish once send_message went through", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(delivered)
    );

    // The note after a delivery says the reply is out, so the model does
    // not read it as a new request to answer.
    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      {
        delivered: true,
        replyNote: note("ru", true),
        toolChoice: "auto",
        withheldTools: [],
      }
    );
  });

  it("makes a turn whose send was dropped end in text", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext([...delivered, ...skippedRepeat("call-2")])
    );

    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      {
        delivered: true,
        replyNote: note("ru", true),
        toolChoice: "none",
        withheldTools: [],
      }
    );
  });

  it("offers ask_question no more once the turn asked the person", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext([
        ...pending,
        {
          content: [
            {
              input: { prompt: "Какие действия выполнить?" },
              toolCallId: "call-q",
              toolName: "ask_question",
              type: "tool-call" as const,
            },
          ],
          role: "assistant" as const,
        },
        {
          content: [
            {
              output: {
                type: "json" as const,
                value: { optionId: "both", status: "answered" },
              },
              toolCallId: "call-q",
              toolName: "ask_question",
              type: "tool-result" as const,
            },
          ],
          role: "tool" as const,
        },
      ])
    );

    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      expect.objectContaining({ withheldTools: ["ask_question"] })
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
      {
        delivered: false,
        replyNote: note("en"),
        toolChoice: "required",
        withheldTools: [],
      }
    );
  });

  it("holds what a question asked about until the person answers", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext([
        humanMessage("найди билеты в сочи"),
        {
          content: [
            {
              input: {
                kind: "message",
                text: "Проверка уже не нужна. Остановить её или оставить?",
              },
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
      ])
    );

    const [, options] = services.modelSelection.mock.lastCall ?? [];
    expect(options?.withheldTools).toEqual([
      "calendar-delete-event",
      "calendar-update-event",
      "profile__remove_memory",
      "schedules-update",
      "workstreams__forget",
    ]);
    // The model learns why they are gone, so it does not claim it used them.
    expect(options?.replyNote).toContain("are not available");
  });

  it("makes a browser run's result act on its first step, then leaves it free", async () => {
    // An empty first step failed the report turn before the person heard
    // anything (gpt-6-luna, 24.09).
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(pending, "browser-result", reportAttributes)
    );

    // A question in a report goes out as a message, so the person's reply
    // starts a turn of their own.
    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      {
        delivered: false,
        replyNote: note("ru"),
        toolChoice: "required",
        withheldTools: ["ask_question"],
      }
    );

    // After a step that did something other than reply — a quiet continue
    // on the errand — the turn may end without a message.
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(
        [
          ...pending,
          {
            content: [
              {
                input: { action: "continue" },
                toolCallId: "call-2",
                toolName: "browser_task",
                type: "tool-call" as const,
              },
            ],
            role: "assistant" as const,
          },
          {
            content: [
              {
                output: { type: "json" as const, value: { status: "running" } },
                toolCallId: "call-2",
                toolName: "browser_task",
                type: "tool-result" as const,
              },
            ],
            role: "tool" as const,
          },
        ],
        "browser-result",
        reportAttributes
      )
    );

    // Nothing more to say after it is a clean end, not a failed turn.
    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      {
        delivered: true,
        replyNote: note("ru"),
        toolChoice: "auto",
        withheldTools: ["ask_question"],
      }
    );
  });

  it("ends a report turn at once when the person already has that report", async () => {
    services.browserRunReportDelivered.mockResolvedValue(true);

    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(pending, "browser-result", reportAttributes)
    );

    expect(services.browserRunReportDelivered).toHaveBeenCalledWith(
      "browser-run-1"
    );
    const [, options] = services.modelSelection.mock.lastCall ?? [];
    expect(options?.toolChoice).toBe("none");
    expect(options?.delivered).toBe(true);
    expect(options?.replyNote).toContain(
      "This browser report already reached the person in an earlier turn"
    );
  });

  it("ends a report turn whose outcome an earlier turn already told", async () => {
    // «ну что там?» took the outcome from `browser_task status` while the
    // report waited behind that turn; the report must not tell it again.
    const statusTold = [
      humanMessage("ну что там с заказом?"),
      toolCallStep("browser_task", "call-status", { action: "status" }),
      toolResultStep("browser_task", "call-status", {
        outcome: "Result: корзина собрана, 1 085,95 ₽.",
        runId: "browser-run-1",
        status: "done",
      }),
      ...delivered.slice(1),
    ];

    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(
        [...statusTold, humanMessage("report")],
        "browser-result",
        reportAttributes
      )
    );

    const [, options] = services.modelSelection.mock.lastCall ?? [];
    expect(options?.toolChoice).toBe("none");
    expect(options?.replyNote).toContain(
      "This browser report already reached the person in an earlier turn"
    );
    expect(services.browserRunReportDelivered).not.toHaveBeenCalled();

    // Another run's outcome, or one nobody was told, leaves the report be.
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(
        [...statusTold.slice(0, 3), humanMessage("report")],
        "browser-result",
        reportAttributes
      )
    );
    expect(services.modelSelection.mock.lastCall?.[1]?.toolChoice).toBe(
      "required"
    );
  });

  it("lets a report turn past its answer still act on the errand", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(
        [...delivered, ...skippedRepeat("call-2")],
        "browser-result",
        reportAttributes
      )
    );

    // Its messages are done, but the one card for the option the run found
    // may still follow.
    const [, options] = services.modelSelection.mock.lastCall ?? [];
    expect(options?.toolChoice).toBe("auto");
    expect(options?.withheldTools).toEqual([
      "ask_question",
      "react_to_message",
      "send_message",
    ]);
  });

  it("never forces a tool on a scheduled report, which may stay suppressed", async () => {
    await agent.model.events["step.started"]?.(
      {},
      interactiveContext(pending, "scheduled-result")
    );

    // The report answers in the language of the conversation it continues,
    // and puts a waiting run's question as a message: the person's reply
    // must start their own turn, where `schedules-answer` takes it.
    expect(services.modelSelection).toHaveBeenLastCalledWith(
      "openai/gpt-5.6-sol-fast",
      {
        delivered: false,
        replyNote: note("ru"),
        toolChoice: "auto",
        withheldTools: ["ask_question"],
      }
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
      {
        delivered: false,
        replyNote: undefined,
        toolChoice: "auto",
        withheldTools: [],
      }
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

function toolCallStep(
  toolName: string,
  toolCallId: string,
  input: Record<string, string>
) {
  return {
    content: [{ input, toolCallId, toolName, type: "tool-call" as const }],
    role: "assistant" as const,
  };
}

function toolResultStep(
  toolName: string,
  toolCallId: string,
  value: Record<string, string>
) {
  return {
    content: [
      {
        output: { type: "json" as const, value },
        toolCallId,
        toolName,
        type: "tool-result" as const,
      },
    ],
    role: "tool" as const,
  };
}

function humanMessage(text: string) {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

/** Every browser report carries the run it reports. */
const reportAttributes = {
  browserRunId: "browser-run-1",
  workspaceId: "workspace-1",
};

function interactiveContext(
  messages: DynamicResolveContext["messages"],
  authenticator = "telegram",
  attributes: Readonly<Record<string, string>> = { workspaceId: "workspace-1" }
): DynamicResolveContext {
  return {
    channel: { kind: "channel:telegram" },
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
