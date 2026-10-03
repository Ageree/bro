import { generateText, simulateReadableStream, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { DynamicResolveContext } from "eve/tools";
import type { Approval, ApprovalContext } from "eve/tools/approval";
import type {
  markTurnDelivered,
  reportDeliveredInTurn,
} from "@agent/lib/delivery/holds";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toolContext } from "@tests/helpers/tool-context";

const services = vi.hoisted(() => ({
  createCalendarEvent: vi.fn<() => Promise<{ id: string }>>(),
  createScheduledAgentJob: vi.fn<() => Promise<never>>(),
  markTurnDelivered: vi.fn<typeof markTurnDelivered>(),
  pilot: vi.fn<() => Promise<boolean>>(),
  reportDelivered: vi.fn<typeof reportDeliveredInTurn>(),
}));

vi.mock("@agent/lib/delivery/holds", () => ({
  markTurnDelivered: services.markTurnDelivered,
  reportDeliveredInTurn: services.reportDelivered,
}));
vi.mock("@agent/lib/step-context/pilot", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stepContextPilotOfTool: services.pilot,
}));
vi.mock("@agent/lib/memory/rule-approval", () => ({
  outboundRuleApproval: async () => "not-applicable",
}));
vi.mock("@agent/lib/google-workspace/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  googleWriteApproval: async () => "user-approval",
}));
vi.mock("@agent/lib/google-workspace/calendar", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createCalendarEvent: services.createCalendarEvent,
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  createScheduledAgentJob: services.createScheduledAgentJob,
}));
vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "full",
}));

import { reportCardHoldRefusal } from "@agent/lib/delivery/report-cards";
import { skippedSendNotice } from "@agent/lib/delivery/turn-sends";
import { calendarCreateEvent } from "@agent/tools/calendar";
import { connectGoogle } from "@agent/tools/google_connect";
import messaging from "@agent/tools/messaging";
import { createSchedule } from "@agent/tools/schedules";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

beforeEach(() => {
  vi.clearAllMocks();
  services.pilot.mockResolvedValue(true);
  services.reportDelivered.mockReturnValue(false);
});

/** A browser report's turn, whose caller names the run. */
function reportContext(toolName: string) {
  const context = toolContext(toolName, "browser-result");
  return {
    ...context,
    session: {
      ...context.session,
      auth: {
        ...context.session.auth,
        current: {
          ...context.session.auth.current,
          attributes: {
            ...context.session.auth.current.attributes,
            browserRunId: "run-1",
          },
        },
      },
    },
  };
}

/** A tool's approval policy, called as eve calls it. */
async function decide<Input>(
  approval: Approval<Input> | undefined,
  context: ReturnType<typeof toolContext>,
  toolInput: ApprovalContext<Input>["toolInput"]
) {
  if (approval === undefined) throw new Error("The tool has no policy.");
  const policy = "request" in approval ? approval.request : approval;
  return policy({ ...context, approvedTools: new Set(), toolInput });
}

const event = {
  attendees: [],
  calendarId: "primary",
  end: "2026-10-03T15:30:00+03:00",
  start: "2026-10-03T14:30:00+03:00",
  summary: "Стрижка",
};
const schedule = {
  missedRunPolicy: "run_latest" as const,
  prompt: "Проверь, открылась ли запись к врачу.",
  timing: { at: "2026-10-04T09:00", kind: "once" as const },
};

const denied = { reason: reportCardHoldRefusal, type: "denied" };

describe("a browser report's card tools before its message", () => {
  it("refuse in their approval and again in their execute", async () => {
    const calendar = reportContext("calendar-create-event");
    expect(await decide(calendarCreateEvent.approval, calendar, event)).toEqual(
      denied
    );
    await expect(calendarCreateEvent.execute(event, calendar)).rejects.toThrow(
      reportCardHoldRefusal
    );
    expect(services.createCalendarEvent).not.toHaveBeenCalled();

    const schedules = reportContext("schedules-create");
    expect(await decide(createSchedule.approval, schedules, schedule)).toEqual(
      denied
    );
    await expect(createSchedule.execute(schedule, schedules)).rejects.toThrow(
      reportCardHoldRefusal
    );
    expect(services.createScheduledAgentJob).not.toHaveBeenCalled();

    const google = reportContext("connect_google");
    expect(
      await decide(connectGoogle.approval, google, {
        action: "status" as const,
      })
    ).toEqual(denied);
    await expect(
      connectGoogle.execute({ action: "status" as const }, google)
    ).rejects.toThrow(reportCardHoldRefusal);
    expect(services.reportDelivered).toHaveBeenCalledWith(
      google.session,
      "run-1"
    );
  });

  it("ask on their card once the turn's message went out", async () => {
    services.reportDelivered.mockReturnValue(true);
    expect(
      await decide(
        calendarCreateEvent.approval,
        reportContext("calendar-create-event"),
        event
      )
    ).toBe("user-approval");
  });

  it("refuse when the turn's state cannot be read", async () => {
    // A `browser_task status` marks the report delivered in the database
    // too; only the turn's own state counts, and an unread one holds.
    services.reportDelivered.mockReturnValue(undefined);
    expect(
      await decide(
        createSchedule.approval,
        reportContext("schedules-create"),
        schedule
      )
    ).toEqual(denied);
  });

  it("hold nothing outside the pilot, where they are not offered before the message", async () => {
    services.pilot.mockResolvedValue(false);
    expect(
      await decide(
        calendarCreateEvent.approval,
        reportContext("calendar-create-event"),
        event
      )
    ).toBe("user-approval");
    expect(services.reportDelivered).not.toHaveBeenCalled();
  });

  it("hold nothing in a person's own turn", async () => {
    expect(
      await decide(
        createSchedule.approval,
        toolContext("schedules-create"),
        schedule
      )
    ).toBe("not-applicable");
    expect(services.pilot).not.toHaveBeenCalled();
    expect(services.reportDelivered).not.toHaveBeenCalled();
  });
});

describe("a browser report's messages past its answer", () => {
  const report = Object.assign(
    {
      content: `${backgroundTurnMarker}\nBrowser run run-1 finished.`,
      role: "user" as const,
    },
    { kind: "user" }
  );
  const told = [
    report,
    {
      content: [
        {
          input: { kind: "message", text: "Записал на 3 октября." },
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
  const pastAnswer = [
    ...told,
    {
      content: [
        {
          input: { kind: "message", text: "Готово." },
          toolCallId: "call-2",
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
          toolCallId: "call-2",
          toolName: "send_message",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
  ];

  async function resolve(messages: DynamicResolveContext["messages"]) {
    const resolver = messaging.events["step.started"];
    if (!resolver) throw new Error("messaging resolves per step");
    const tools = await resolver(
      {},
      {
        channel: { kind: "channel:telegram", metadata: {} },
        messages,
        model: null,
        session: {
          auth: reportContext("send_message").session.auth,
          id: "session-1",
        },
      }
    );
    if (!tools || "execute" in tools || !("react_to_message" in tools)) {
      throw new Error("A report turn has both messaging tools.");
    }
    return tools;
  }

  it("send nothing, and say it was not sent", async () => {
    const tools = await resolve(pastAnswer);
    const message = { kind: "message" as const, text: "Ещё раз: записал." };
    const output = await tools.send_message.execute(
      message,
      reportContext("send_message")
    );
    expect(output).toEqual({ skipped: "past" });
    expect(services.markTurnDelivered).not.toHaveBeenCalled();
    const notice = await tools.send_message.toModelOutput?.({
      skipped: "past",
    });
    expect(notice?.type === "text" ? notice.value : "").toBe(
      skippedSendNotice("past")
    );
    expect(skippedSendNotice("past")).toContain("Do not say this one was sent");

    await expect(async () =>
      tools.react_to_message.execute(
        { operation: "add", type: "thumbs_up" },
        reportContext("react_to_message")
      )
    ).rejects.toThrow("Not sent");
  });

  it("go out before it, and record the turn's message", async () => {
    const tools = await resolve([report]);
    const message = { kind: "message" as const, text: "Записал на 3 октября." };
    const context = reportContext("send_message");
    expect(await tools.send_message.execute(message, context)).toEqual(message);
    expect(services.markTurnDelivered).toHaveBeenCalledExactlyOnceWith(
      context.session
    );
  });
});

/**
 * The card tools refuse until `send_message` recorded the turn's message
 * (`markTurnDelivered`, in its execute). A card asked for in the very step of
 * the message must still be refused: the AI SDK decides the approval of
 * every call of a step as the calls arrive, and runs the calls only once the
 * step's model call ended (`execute-tools-from-stream`, and the same order in
 * `generateText`), so no execute of the step runs before an approval of it.
 * This pins that order; if an upgrade changed it, the hold would have to
 * look at messages of earlier steps only.
 */
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const calls = [
  {
    input: JSON.stringify({ text: "Записал на 3 октября." }),
    toolCallId: "call-message",
    toolName: "send_message",
    type: "tool-call" as const,
  },
  {
    input: JSON.stringify({ summary: "Стрижка" }),
    toolCallId: "call-card",
    toolName: "calendar-create-event",
    type: "tool-call" as const,
  },
];

/** One step that calls `send_message` and a card tool together. */
function messageAndCard() {
  let delivered = false;
  const seen: boolean[] = [];
  return {
    recorded: () => delivered,
    seen,
    toolApproval: async ({
      toolCall,
    }: {
      readonly toolCall: { readonly toolName: string };
    }) => {
      if (toolCall.toolName !== "calendar-create-event") {
        return "not-applicable" as const;
      }
      // An approval that awaits, as `reportCardHold` does.
      await Promise.resolve();
      seen.push(delivered);
      return delivered
        ? ("user-approval" as const)
        : { reason: reportCardHoldRefusal, type: "denied" as const };
    },
    tools: {
      "calendar-create-event": tool({
        execute: () => ({ created: true }),
        inputSchema: z.object({ summary: z.string() }),
      }),
      send_message: tool({
        execute: (message: { readonly text: string }) => {
          delivered = true;
          return message;
        },
        inputSchema: z.object({ text: z.string() }),
      }),
    },
  };
}

describe("a card in the step of the turn's message", () => {
  it("is decided before the message is recorded, when the step is generated", async () => {
    const { recorded, seen, toolApproval, tools } = messageAndCard();
    await generateText({
      model: new MockLanguageModelV4({
        doGenerate: async () => ({
          content: calls,
          finishReason: { raw: "tool_calls", unified: "tool-calls" },
          usage,
          warnings: [],
        }),
      }),
      prompt: "Browser run finished",
      toolApproval,
      tools,
    });
    expect(seen).toEqual([false]);
    expect(recorded()).toBe(true);
  });

  it("is decided before the message is recorded, when the step is streamed", async () => {
    const { recorded, seen, toolApproval, tools } = messageAndCard();
    const result = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              ...calls,
              {
                finishReason: { raw: "tool_calls", unified: "tool-calls" },
                type: "finish" as const,
                usage,
              },
            ],
          }),
        }),
      }),
      prompt: "Browser run finished",
      toolApproval,
      tools,
    });
    await result.consumeStream();
    expect(seen).toEqual([false]);
    expect(recorded()).toBe(true);
  });
});
