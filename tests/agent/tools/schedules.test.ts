import type {
  DynamicResolveContext,
  ToolContext,
  ToolDefinition,
} from "eve/tools";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  createScheduledAgentJob,
  getScheduledAgentRunInput,
  listScheduledAgentJobs,
  submitScheduledAgentRunAnswer,
  updateScheduledAgentJob,
} from "@db/services/scheduled-agent-jobs";

const services = vi.hoisted(() => ({
  create: vi.fn<typeof createScheduledAgentJob>(),
  getInput: vi.fn<typeof getScheduledAgentRunInput>(),
  list: vi.fn<typeof listScheduledAgentJobs>(),
  submitAnswer: vi.fn<typeof submitScheduledAgentRunAnswer>(),
  update: vi.fn<typeof updateScheduledAgentJob>(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  createScheduledAgentJob: services.create,
  getScheduledAgentRunInput: services.getInput,
  listScheduledAgentJobs: services.list,
  submitScheduledAgentRunAnswer: services.submitAnswer,
  updateScheduledAgentJob: services.update,
}));

import { backgroundTurnMarker } from "@shared/chat/background-turn";
import messaging from "@agent/tools/messaging";
import schedules, {
  createSchedule,
  listSchedules,
  updateSchedule,
} from "@agent/tools/schedules";

const airportQuestion = {
  action: {
    callId: "call-question",
    input: { prompt: "Which airport should I use?" },
    kind: "tool-call" as const,
    toolName: "ask_question",
  },
  allowFreeform: true,
  kind: "question" as const,
  prompt: "Which airport should I use?",
  requestId: "request-airport",
};

describe("schedule tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
    services.submitAnswer.mockResolvedValue(true);
  });

  it("resumes a run with the person's answer to the question this chat showed", async () => {
    const answer = await answerTool(
      dynamicContext("photon-imessage", "channel:photon", [
        ...questionShown(runId),
        person("DCA"),
      ])
    );
    services.getInput.mockResolvedValue({
      leaseToken,
      pendingInputRequests: [airportQuestion],
      runId,
    });

    await answer.execute(
      { answer: "DCA", runId },
      toolContext("schedules-answer", "photon-imessage")
    );
    expect(services.getInput).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      runId
    );
    // It is stored for the `dynamic` tick, never posted to an app route
    // that eve on Vercel would not receive.
    expect(services.submitAnswer).toHaveBeenCalledExactlyOnceWith(
      runId,
      leaseToken,
      [{ requestId: "request-airport", text: "DCA" }]
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never lets a turn the person did not start answer for them", async () => {
    const resolve = schedules.events["turn.started"];
    if (!resolve) throw new Error("Expected a turn resolver.");

    // A scheduled report, a browser report and a worker speak for nobody.
    const resolved = await Promise.all(
      ["scheduled-result", "browser-result", "scheduled-worker"].map(
        async (authenticator) =>
          resolve(
            {},
            dynamicContext(
              authenticator,
              "channel:photon",
              questionShown(runId)
            )
          )
      )
    );
    for (const tools of resolved) {
      expect(
        tools && !("execute" in tools) ? Object.keys(tools) : []
      ).not.toContain("schedules-answer");
    }
    expect(await resolve({}, resumedWorkerContext())).toBeNull();

    const answer = await answerTool(
      dynamicContext("photon-imessage", "channel:photon", [
        ...questionShown(runId),
        person("LGA"),
      ])
    );
    await expect(
      answer.execute(
        { answer: "LGA", runId },
        toolContext("schedules-answer", "browser-result")
      )
    ).rejects.toThrow("only the user's own reply answers");
    expect(services.getInput).not.toHaveBeenCalled();
    expect(services.submitAnswer).not.toHaveBeenCalled();
  });

  it("refuses to answer a question this chat never showed the person", async () => {
    // «Напиши Лёше, что я опоздаю»: nothing in this chat asked about the
    // budget table, so the model's made-up answer for an old run goes nowhere.
    const otherRun = "00000000-0000-4000-8000-000000000009";
    const answer = await answerTool(
      dynamicContext("photon-imessage", "channel:photon", [
        ...questionShown(runId),
        person("Напиши Лёше, что я опоздаю"),
      ])
    );

    await expect(
      answer.execute(
        {
          answer: "Таблица бюджета не найдена, дождаться ссылки",
          runId: otherRun,
        },
        toolContext("schedules-answer", "photon-imessage")
      )
    ).rejects.toThrow(notReplied);
    // The report turn brought the question here but never delivered it:
    // with nothing to reply to, the tool is not there at all.
    expect(
      await offeredTools(
        dynamicContext("photon-imessage", "channel:photon", [
          ...questionShown(runId).slice(0, 1),
          person("DCA"),
        ])
      )
    ).not.toContain("schedules-answer");
    expect(services.getInput).not.toHaveBeenCalled();
  });

  it("offers no answer to a run when the person's message replies to no question of one", async () => {
    // RU d15: Bro asked its own question with ask_question, the person
    // answered, and the model passed the answer to schedules-answer.
    const tools = await offeredTools(
      dynamicContext("telegram-webhook", "channel:telegram", [
        person(
          "запиши меня завтра в барбершоп к артуру, напомни в восемь маме позвонить"
        ),
        {
          content: [
            {
              input: { prompt: "На какое время записать?" },
              toolCallId: "call-ask",
              toolName: "ask_question",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              output: {
                type: "json",
                value: { status: "answered", text: "на семь вечера" },
              },
              toolCallId: "call-ask",
              toolName: "ask_question",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ])
    );

    expect(tools).toEqual([
      "schedules-create",
      "schedules-list",
      "schedules-update",
    ]);
  });

  it("refuses an old question the person already wrote past", async () => {
    // The airport question reached the chat days ago; the person wrote about
    // something else and now asks about dinner. Their message answers
    // nothing, so there is no run for the model to settle for them.
    expect(
      await offeredTools(
        dynamicContext("photon-imessage", "channel:photon", [
          person("Найди мне рейс в Вашингтон на пятницу"),
          ...questionShown(runId),
          person("Напиши Лёше, что я опоздаю"),
          ...assistantSend("Написал Лёше."),
          person("Забронируй столик на вечер"),
        ])
      )
    ).not.toContain("schedules-answer");
    expect(services.getInput).not.toHaveBeenCalled();

    // Another report in between — a browser run's result — does not end the
    // person's chance to reply: their next message still answers.
    const browserReport = person(
      `${backgroundTurnMarker}\n\nBrowser run 123 finished.`
    );
    const reply = await answerTool(
      dynamicContext("telegram-webhook", "channel:telegram", [
        person("Напиши Лёше, что я опоздаю"),
        ...questionShown(runId),
        browserReport,
        ...assistantSend("Столик забронирован."),
        person("DCA"),
      ])
    );
    services.getInput.mockResolvedValue({
      leaseToken,
      pendingInputRequests: [airportQuestion],
      runId,
    });
    expect(
      await reply.execute(
        { answer: "DCA", runId },
        toolContext("schedules-answer", "telegram-webhook")
      )
    ).toEqual({ accepted: true, runId });
  });

  it("rejects an answer that matches none of the pending choices", async () => {
    services.getInput.mockResolvedValue({
      leaseToken,
      pendingInputRequests: [
        {
          ...airportQuestion,
          allowFreeform: false,
          options: [
            { id: "dca", label: "DCA" },
            { id: "iad", label: "IAD" },
          ],
        },
      ],
      runId,
    });
    const answer = await answerTool(
      dynamicContext("telegram-webhook", "channel:telegram", [
        ...questionShown(runId),
        person("Heathrow"),
      ])
    );

    await expect(
      answer.execute(
        { answer: "Heathrow", runId },
        toolContext("schedules-answer", "telegram-webhook")
      )
    ).rejects.toThrow("That answer does not match the pending choices.");
    expect(services.submitAnswer).not.toHaveBeenCalled();

    await answer.execute(
      { answer: "IAD", runId },
      toolContext("schedules-answer", "telegram-webhook")
    );
    expect(services.submitAnswer).toHaveBeenCalledExactlyOnceWith(
      runId,
      leaseToken,
      [{ optionId: "iad", requestId: "request-airport" }]
    );
  });

  it("creates a schedule without a multiplexed action field", async () => {
    const job = scheduledJob();
    services.create.mockResolvedValue(job);

    const result = await createSchedule.execute(
      {
        missedRunPolicy: "run_latest",
        prompt: "Send the morning summary.",
        timing: {
          frequency: "daily",
          kind: "calendar",
          localTime: "09:00",
          timezone: "America/New_York",
        },
      },
      toolContext("schedules-create")
    );

    expect(inputProperties(createSchedule.inputSchema)).toEqual([
      "missedRunPolicy",
      "prompt",
      "timing",
    ]);
    expect(services.create).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        conversationChannel: "photon",
        conversationId: "imessage:dm:chat-1",
        missedRunPolicy: "run_latest",
        prompt: "Send the morning summary.",
        replyAnchorMessageId: "message-1",
        timing: {
          frequency: "daily",
          kind: "calendar",
          localTime: "09:00",
          timezone: "America/New_York",
        },
      }
    );
    expect(result).toEqual(scheduleSummary(job));
  });

  it("lists schedules through a dedicated empty-input tool", async () => {
    const job = scheduledJob();
    services.list.mockResolvedValue([job]);

    const result = await listSchedules.execute(
      {},
      toolContext("schedules-list")
    );

    expect(inputProperties(listSchedules.inputSchema)).toEqual([]);
    // Every schedule of the person, whichever chat asks.
    expect(services.list).toHaveBeenCalledExactlyOnceWith({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(result).toEqual([scheduleListSummary(job)]);
  });

  it("updates a schedule without carrying an action discriminator", async () => {
    const job = scheduledJob();
    services.update.mockResolvedValue(job);

    const result = await updateSchedule.execute(
      {
        id: job.id,
        status: "paused",
      },
      toolContext("schedules-update")
    );

    expect(inputProperties(updateSchedule.inputSchema)).toEqual([
      "id",
      "prompt",
      "status",
      "timing",
    ]);
    expect(services.update).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      job.id,
      { status: "paused" }
    );
    expect(result).toEqual(scheduleSummary(job));
  });

  it("omits messaging capabilities outside their valid turns", async () => {
    const resolveMessaging = messaging.events["step.started"];
    expect(resolveMessaging).toBeDefined();
    if (!resolveMessaging) return;

    expect(
      await resolveMessaging({}, dynamicContext("scheduled-worker"))
    ).toBeNull();
    expect(await resolveMessaging({}, resumedWorkerContext())).toBeNull();
    const reportMessaging = await resolveMessaging(
      {},
      dynamicContext("scheduled-result", "channel:photon")
    );
    expect(Object.keys(reportMessaging ?? {})).toEqual(["send_message"]);

    const debugMessaging = await resolveMessaging(
      {},
      dynamicContext("test", "http")
    );
    const interactiveMessaging = await resolveMessaging(
      {},
      dynamicContext("test", "channel:photon")
    );
    expect(Object.keys(debugMessaging ?? {}).toSorted()).toEqual([
      "send_message",
    ]);
    expect(Object.keys(interactiveMessaging ?? {}).toSorted()).toEqual([
      "react_to_message",
      "send_message",
    ]);
    const reportSend =
      reportMessaging && !("execute" in reportMessaging)
        ? reportMessaging.send_message
        : undefined;
    const interactiveSend =
      interactiveMessaging && !("execute" in interactiveMessaging)
        ? interactiveMessaging.send_message
        : undefined;
    const debugSend =
      debugMessaging && !("execute" in debugMessaging)
        ? debugMessaging.send_message
        : undefined;
    if (
      !(reportSend?.inputSchema instanceof z.ZodType) ||
      !(interactiveSend?.inputSchema instanceof z.ZodType) ||
      !(debugSend?.inputSchema instanceof z.ZodType)
    ) {
      throw new Error("Expected authored send_message schemas.");
    }
    const reply = {
      kind: "message",
      replyTo: { kind: "current" as const },
      text: "This one.",
    };
    expect(interactiveSend.inputSchema.safeParse(reply).success).toBe(true);
    expect(debugSend.inputSchema.safeParse(reply).success).toBe(true);
    expect(reportSend.inputSchema.safeParse(reply).success).toBe(true);
  });

  it("owns web schedules by their Eve session", async () => {
    const job = scheduledJob({
      conversationChannel: "eve",
      conversationId: "session-1",
    });
    services.create.mockResolvedValue(job);

    await createSchedule.execute(
      {
        missedRunPolicy: "run_latest",
        prompt: "Send the morning summary.",
        timing: {
          frequency: "daily",
          kind: "calendar",
          localTime: "09:00",
          timezone: "America/New_York",
        },
      },
      toolContext("schedules-create", "test", "eve")
    );

    expect(services.create).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      expect.objectContaining({
        conversationChannel: "eve",
        conversationId: "session-1",
      })
    );
  });
});

const runId = "00000000-0000-4000-8000-000000000002";
const leaseToken = "00000000-0000-4000-8000-000000000003";
const notReplied = "is not a reply to that scheduled task's question";

/** A step of Bro's that delivered a message to the chat. */
function assistantSend(text: string): ModelMessage[] {
  const toolCallId = `call-${text}`;
  return [
    {
      content: [
        {
          input: { kind: "message", text },
          toolCallId,
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "json", value: { kind: "message", text } },
          toolCallId,
          toolName: "send_message",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

function person(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    {
      kind: "user",
    }
  );
}

/** A report turn that put the run's question to the person. */
function questionShown(id: string): ModelMessage[] {
  return [
    person(
      [
        backgroundTurnMarker,
        "A background scheduled run is waiting for the user before it can continue.",
        "Original task: Check flights to Washington.",
        `Internal run ID: ${id}`,
        `Pending request: ${JSON.stringify([airportQuestion])}`,
      ].join("\n\n")
    ),
    {
      content: [
        {
          input: { kind: "message", text: "Какой аэропорт взять?" },
          toolCallId: "call-send",
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: {
            type: "json",
            value: { kind: "message", text: "Какой аэропорт взять?" },
          },
          toolCallId: "call-send",
          toolName: "send_message",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

async function offeredTools(context: DynamicResolveContext) {
  const resolve = schedules.events["turn.started"];
  const tools = resolve ? await resolve({}, context) : null;
  return tools && !("execute" in tools) ? Object.keys(tools) : [];
}

async function answerTool(context: DynamicResolveContext) {
  const resolve = schedules.events["turn.started"];
  const tools = resolve ? await resolve({}, context) : null;
  const answer =
    tools && "schedules-answer" in tools
      ? tools["schedules-answer"]
      : undefined;
  if (!answer) throw new Error("Expected the schedules-answer tool.");
  return answer;
}

function dynamicContext(
  authenticator: string,
  kind = "channel:scheduled-run",
  messages: ModelMessage[] = []
) {
  return {
    model: null,
    channel: { kind, metadata: {} },
    messages,
    session: {
      auth: {
        current: {
          attributes: {},
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

function resumedWorkerContext() {
  const context = dynamicContext("photon-imessage");
  return {
    ...context,
    session: {
      ...context.session,
      auth: {
        ...context.session.auth,
        initiator: {
          attributes: {},
          authenticator: "scheduled-worker",
          principalId: "user-1",
          principalType: "user" as const,
        },
      },
    },
  } satisfies DynamicResolveContext;
}

function toolContext(
  toolName: string,
  authenticator = "test",
  conversationChannel: "eve" | "photon" = "photon"
) {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-schedule",
    async getSandbox() {
      throw new Error("Sandbox access is not expected.");
    },
    getSkill() {
      throw new Error("Skill access is not expected.");
    },
    async getToken() {
      throw new Error("Token access is not expected.");
    },
    requireAuth() {
      throw new Error("Connection authorization is not expected.");
    },
    session: {
      auth: {
        current: {
          attributes: {
            conversationChannel,
            conversationId: "imessage:dm:chat-1",
            photonMessageId: "message-1",
            photonThreadId: "imessage:dm:chat-1",
            workspaceId: "workspace-1",
          },
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName,
  } satisfies ToolContext;
}

function inputProperties(schema: ToolDefinition["inputSchema"]) {
  if (!(schema instanceof z.ZodType)) {
    throw new TypeError("Expected an authored Zod input schema.");
  }
  return Object.keys(z.toJSONSchema(schema).properties ?? {});
}

function scheduledJob(
  conversation: {
    conversationChannel: "eve" | "photon";
    conversationId: string;
  } = {
    conversationChannel: "photon",
    conversationId: "imessage:dm:chat-1",
  }
): Awaited<ReturnType<typeof listScheduledAgentJobs>>[number] {
  return {
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    createdByUserId: "user-1",
    id: "00000000-0000-4000-8000-000000000001",
    kind: "task",
    lastError: null,
    lastRunAt: null,
    latestRun: null,
    ...conversation,
    missedRunPolicy: "run_latest",
    nextRunAt: new Date("2026-09-02T13:00:00.000Z"),
    prompt: "Send the morning summary.",
    replyAnchorMessageId: null,
    revision: 0,
    status: "active",
    timing: {
      frequency: "daily",
      kind: "calendar",
      localTime: "09:00",
      timezone: "America/New_York",
    },
    updatedAt: new Date("2026-09-01T12:00:00.000Z"),
    workspaceId: "workspace-1",
  };
}

function scheduleSummary(job: ReturnType<typeof scheduledJob>) {
  return {
    createdAt: job.createdAt.toISOString(),
    createdIn: job.conversationChannel === "eve" ? "web chat" : "iMessage",
    id: job.id,
    lastError: job.lastError,
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    nextRunAt: job.nextRunAt?.toISOString() ?? null,
    prompt: job.prompt,
    status: job.status,
    timing: job.timing,
  };
}

function scheduleListSummary(job: ReturnType<typeof scheduledJob>) {
  return { ...scheduleSummary(job), latestRun: null };
}
