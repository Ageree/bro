import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Session } from "eve/channels";
import type { ScheduleHandlerArgs, ScheduleToFn } from "eve/schedules";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import type { ModelMessage } from "ai";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import * as Database from "@db";
import * as schema from "@db/schema";
import { recordProactiveTarget } from "@db/services/proactive";
import {
  claimReadyScheduledAgentRuns,
  claimScheduledReport,
  completeScheduledAgentRun,
  createScheduledAgentJob,
  finalizeScheduledReport,
  listScheduledAgentJobs,
  materializeDueScheduledAgentRuns,
  setScheduledRunSession,
  waitForScheduledAgentRunInput,
} from "@db/services/scheduled-agent-jobs";
import { ensureScope } from "@db/services/scope";
import { patchUserProfile } from "@db/services/user-profile";
import dynamicSchedule from "@agent/schedules/dynamic";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import schedulesTools, {
  createSchedule,
  listSchedules,
  updateSchedule,
} from "@agent/tools/schedules";

// The real tools, services and `dynamic` tick run against a real schema;
// only the channels work is handed to stay outside.
vi.mock("@agent/channels/photon", () => ({ default: { channel: "photon" } }));
vi.mock("@agent/channels/telegram", () => ({
  default: { channel: "telegram" },
}));
vi.mock("@agent/channels/scheduled-run", () => ({
  default: { channel: "scheduled-run" },
}));
vi.mock("@agent/lib/model/credits", () => ({
  checkOpenRouterCredits: vi.fn<() => Promise<void>>(),
  creditCheckDue: () => false,
}));

const client = new PGlite();
const database = drizzle(client, { schema });
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const telegram = {
  conversationChannel: "telegram" as const,
  conversationId: "100::",
};
const web = {
  conversationChannel: "eve" as const,
  conversationId: "web-session-alice",
};
const now = new Date("2026-09-24T09:00:00.000Z");
// «Напоминай каждое 5-е число в 10 утра оплатить квартиру».
const rent = {
  missedRunPolicy: "run_latest" as const,
  prompt: "Напомнить оплатить квартиру.",
  timing: {
    dayOfMonth: 5,
    frequency: "monthly" as const,
    kind: "calendar" as const,
    localTime: "10:00",
    timezone: "Europe/Moscow",
  },
};
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

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 30_000);

beforeEach(async () => {
  await database.delete(schema.workspaces);
  await ensureScope(alice);
  await ensureScope(bob);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("schedules belong to the person, not the chat", () => {
  it("lists and changes a Telegram schedule from the web chat and iMessage", async () => {
    const created = z
      .object({ id: z.uuid(), nextRunAt: z.string() })
      .parse(
        await createSchedule.execute(
          rent,
          toolContext("schedules-create", alice, telegram)
        )
      );
    // A calendar rule, not 43 200 minutes: 10:00 in Moscow on 5 October.
    expect(created.nextRunAt).toBe("2026-10-05T07:00:00.000Z");

    const fromWeb = await listSchedules.execute(
      {},
      toolContext("schedules-list", alice, web)
    );
    expect(fromWeb).toEqual([
      expect.objectContaining({
        createdIn: "Telegram",
        id: created.id,
        timing: rent.timing,
      }),
    ]);
    // Nobody else sees it, from any chat.
    expect(
      await listSchedules.execute(
        {},
        toolContext("schedules-list", bob, {
          conversationChannel: "telegram",
          conversationId: "200::",
        })
      )
    ).toEqual([]);

    await updateSchedule.execute(
      { id: created.id, status: "paused" },
      toolContext("schedules-update", alice, {
        conversationChannel: "photon",
        conversationId: "imessage:dm:alice",
      })
    );
    expect(await listScheduledAgentJobs(alice)).toEqual([
      expect.objectContaining({ id: created.id, status: "paused" }),
    ]);
    await expect(
      updateSchedule.execute(
        { id: created.id, status: "deleted" },
        toolContext("schedules-update", bob, telegram)
      )
    ).rejects.toThrow("Schedule not found.");
  });

  it("keeps the report in the messenger after the person opened the web chat", async () => {
    // Set up in Telegram; the person has since written from the web chat
    // once, which has no pushes: «напомни в 9» must still reach Telegram.
    await recordProactiveTarget(alice, telegram, now);
    const job = await createScheduledAgentJob(
      alice,
      { ...telegram, ...rent, replyAnchorMessageId: "telegram-message" },
      now
    );
    await recordProactiveTarget(alice, web, now);
    vi.setSystemTime(new Date("2026-10-05T07:00:30.000Z"));

    const workerSend = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(session("worker-session"));
    await runDynamicTick(scheduleHandles(workerSend));
    const run = await database.query.scheduledAgentRuns.findFirst({
      where: eq(schema.scheduledAgentRuns.jobId, job.id),
    });
    if (!run?.leaseToken) throw new Error("Expected a leased run.");
    expect(run.scheduledFor).toEqual(new Date("2026-10-05T07:00:00.000Z"));
    await completeScheduledAgentRun(run.id, run.leaseToken, "turn-1", {
      kind: "result",
      summary: "Пора оплатить квартиру.",
      urgency: "normal",
    });

    const reportSend = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(session("telegram-session"));
    const handles = scheduleHandles(reportSend);
    await runDynamicTick(handles);

    expect(handles.attachSession).not.toHaveBeenCalled();
    expect(handles.to).toHaveBeenCalledExactlyOnceWith(
      { channel: "telegram" },
      { chatId: "100" }
    );
    const [prompt, options] = reportSend.mock.calls[0] ?? [];
    expect(prompt).toContain("Пора оплатить квартиру.");
    // The report lands in the chat the schedule was set up in, so the reply
    // anchor goes along.
    expect(prompt).toContain("Reply handle");
    expect(options?.auth?.attributes).toMatchObject({
      conversationChannel: "telegram",
      conversationId: telegram.conversationId,
      telegramReplyAnchorMessageId: "telegram-message",
    });
    // The next occurrence is the 5th of November, not 30 days later.
    expect(await listScheduledAgentJobs(alice)).toEqual([
      expect.objectContaining({
        nextRunAt: new Date("2026-11-05T07:00:00.000Z"),
      }),
    ]);
  });

  it("resumes a waiting run with the answer given in the chat that asked", async () => {
    const run = await waitingRun();
    const answer = await answerInChat(alice, run.id);

    const result = await answer.execute(
      { answer: "LGA", runId: run.id },
      toolContext("schedules-answer", alice, telegram, "telegram-webhook")
    );
    expect(result).toEqual({ accepted: true, runId: run.id });
    // Someone else's chat cannot answer it.
    await expect(
      (await answerInChat(bob, run.id)).execute(
        { answer: "DCA", runId: run.id },
        toolContext("schedules-answer", bob, telegram, "telegram-webhook")
      )
    ).rejects.toThrow("That scheduled task is not waiting for input.");
    // Nor can a chat the question never reached, or a model answering
    // without it.
    await expect(
      (await answerInChat(alice, run.id, { shown: false })).execute(
        { answer: "DCA", runId: run.id },
        toolContext("schedules-answer", alice, web, "authjs")
      )
    ).rejects.toThrow("is not a reply to that scheduled task's question");

    const respond = vi
      .fn<Session["respond"]>()
      .mockResolvedValue({ sessionId: "worker-session", status: "accepted" });
    const handles = scheduleHandles(undefined, respond);
    await runDynamicTick(handles);

    expect(handles.attachSession).toHaveBeenCalledExactlyOnceWith(
      "worker-session"
    );
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toEqual([
      { requestId: "request-airport", text: "LGA" },
    ]);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      auth: { authenticator: "scheduled-input" },
    });
    const resumed = await database.query.scheduledAgentRuns.findFirst({
      where: eq(schema.scheduledAgentRuns.id, run.id),
    });
    expect(resumed).toMatchObject({
      inputResponses: null,
      pendingInputRequests: null,
      reportStatus: "not_ready",
      status: "running",
    });

    // The answer is handed over once.
    const again = scheduleHandles();
    await runDynamicTick(again);
    expect(again.attachSession).not.toHaveBeenCalled();
  });

  it("moves 10:00 with the person to their new timezone", async () => {
    const job = await createScheduledAgentJob(
      alice,
      { ...telegram, ...rent },
      now
    );
    const newYork = await createScheduledAgentJob(
      alice,
      {
        ...telegram,
        ...rent,
        timing: { ...rent.timing, timezone: "America/New_York" },
      },
      now
    );

    await patchUserProfile(alice, { timezone: "Asia/Yekaterinburg" });

    const jobs = await listScheduledAgentJobs(alice);
    expect(jobs.find(({ id }) => id === job.id)).toMatchObject({
      nextRunAt: new Date("2026-10-05T05:00:00.000Z"),
      timing: { ...rent.timing, timezone: "Asia/Yekaterinburg" },
    });
    // A schedule set in another zone on purpose keeps it.
    expect(jobs.find(({ id }) => id === newYork.id)).toMatchObject({
      nextRunAt: new Date("2026-10-05T14:00:00.000Z"),
      timing: { timezone: "America/New_York" },
    });
  });
});

/** A Telegram schedule's run waiting on a question the person was asked. */
async function waitingRun() {
  await createScheduledAgentJob(
    alice,
    {
      ...telegram,
      missedRunPolicy: "run_latest",
      prompt: "Find a flight to New York.",
      timing: { at: "2026-09-24T09:01:00.000Z", kind: "once" },
    },
    now
  );
  const dueAt = new Date("2026-09-24T09:02:00.000Z");
  await materializeDueScheduledAgentRuns({ limit: 10, now: dueAt });
  const [claim] = await claimReadyScheduledAgentRuns({
    leaseForMs: 60_000,
    limit: 10,
    now: dueAt,
  });
  if (!claim?.run.leaseToken) throw new Error("Expected a claimed run.");
  await setScheduledRunSession(
    claim.run.id,
    claim.run.leaseToken,
    "worker-session"
  );
  await waitForScheduledAgentRunInput(
    claim.run.id,
    claim.run.leaseToken,
    [airportQuestion],
    dueAt
  );
  const report = await claimScheduledReport(claim.run.id, dueAt);
  if (!report?.run.reportLeaseToken) throw new Error("Expected a report.");
  await finalizeScheduledReport(
    claim.run.id,
    report.run.reportLeaseToken,
    "delivered"
  );
  return claim.run;
}

/**
 * The answer tool of a Telegram turn whose chat was asked the run's
 * question — the report turn brought it here and delivered it — or, when
 * not `shown`, of a web chat turn the question never reached.
 */
async function answerInChat(
  scope: typeof alice,
  runId: string,
  { shown }: { shown: boolean } = { shown: true }
) {
  const current = {
    attributes: {
      ...(shown ? telegram : web),
      workspaceId: scope.workspaceId,
    },
    authenticator: shown ? "telegram-webhook" : "authjs",
    principalId: scope.userId,
    principalType: "user",
  };
  const question: ModelMessage[] = [
    {
      content: [
        backgroundTurnMarker,
        "A background scheduled run is waiting for the user before it can continue.",
        `Internal run ID: ${runId}`,
      ].join("\n\n"),
      role: "user",
    },
    {
      content: [
        {
          input: { kind: "message", text: "Какой аэропорт?" },
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
          output: { type: "json", value: { kind: "message" } },
          toolCallId: "call-send",
          toolName: "send_message",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
  const messages: ModelMessage[] = [
    ...(shown ? question : []),
    { content: "LGA", role: "user" },
  ];
  const resolve = schedulesTools.events["turn.started"];
  const tools = resolve
    ? await resolve({}, {
        channel: {
          kind: shown ? "channel:telegram" : "channel:eve",
          metadata: {},
        },
        messages,
        model: null,
        session: {
          auth: { current, initiator: null },
          id: shown ? "telegram" : web.conversationId,
        },
      } satisfies DynamicResolveContext)
    : null;
  const answer =
    tools && "schedules-answer" in tools
      ? tools["schedules-answer"]
      : undefined;
  if (!answer) throw new Error("Expected the schedules-answer tool.");
  return answer;
}

function toolContext(
  toolName: string,
  scope: typeof alice,
  conversation: { conversationChannel: string; conversationId: string },
  authenticator = "test"
) {
  return {
    abortSignal: new AbortController().signal,
    callId: `call-${toolName}`,
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
          attributes: { ...conversation, workspaceId: scope.workspaceId },
          authenticator,
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      // A web chat is addressed by its session.
      id: conversation.conversationId,
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName,
  } satisfies ToolContext;
}

/** The handles a schedule tick gets, recording what reached each chat. */
function scheduleHandles(
  workerSend = vi.fn<ReturnType<ScheduleToFn>["send"]>(),
  respond = vi.fn<Session["respond"]>()
) {
  const send = vi
    .fn<Session["send"]>()
    .mockResolvedValue({ sessionId: web.conversationId, status: "accepted" });
  return {
    attachSession: vi
      .fn<ScheduleHandlerArgs["attachSession"]>()
      .mockImplementation((id) => ({ ...session(id, send), respond })),
    send,
    to: vi.fn<ScheduleToFn>(() => ({ send: workerSend })),
  };
}

async function runDynamicTick(
  handles: Pick<ScheduleHandlerArgs, "attachSession" | "to">
) {
  const tasks: Promise<unknown>[] = [];
  dynamicSchedule.run({
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession: handles.attachSession,
    to: handles.to,
    waitUntil(task) {
      tasks.push(task);
    },
  });
  await Promise.all(tasks);
}

function session(id: string, send = vi.fn<Session["send"]>()): Session {
  return {
    cancel: vi.fn<Session["cancel"]>(),
    clear: vi.fn<Session["clear"]>(),
    compact: vi.fn<Session["compact"]>(),
    getEventStream: vi.fn<Session["getEventStream"]>(),
    getStreamTailIndex: vi.fn<Session["getStreamTailIndex"]>(),
    id,
    reset: vi.fn<Session["reset"]>(),
    respond: vi.fn<Session["respond"]>(),
    send,
  };
}
