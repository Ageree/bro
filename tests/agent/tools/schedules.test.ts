import type {
  DynamicResolveContext,
  ToolContext,
  ToolDefinition,
} from "eve/tools";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  createScheduledAgentJob,
  getScheduledAgentJob,
  getScheduledAgentRunInput,
  listScheduledAgentJobs,
  queueScheduledAgentRunNow,
  reportConversations,
  submitScheduledAgentRunAnswer,
  updateScheduledAgentJob,
} from "@db/services/scheduled-agent-jobs";
import type {
  listLiveSubscriptions,
  setSubscriptionStatus,
} from "@db/services/subscriptions";
import type { readWorkspaceTimeZone } from "@db/services/user-profile";
import type { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";

const watches = vi.hoisted(() => ({
  list: vi.fn<typeof listLiveSubscriptions>(() => Promise.resolve([])),
  locationPilot: vi.fn<() => boolean>(() => true),
  pilot: vi.fn<typeof subscriptionsPilot>(() => Promise.resolve(true)),
  setStatus: vi.fn<typeof setSubscriptionStatus>(),
}));

const services = vi.hoisted(() => ({
  create: vi.fn<typeof createScheduledAgentJob>(),
  getJob: vi.fn<typeof getScheduledAgentJob>(),
  getInput: vi.fn<typeof getScheduledAgentRunInput>(),
  list: vi.fn<typeof listScheduledAgentJobs>(),
  report: vi.fn<typeof reportConversations>(),
  runNow: vi.fn<typeof queueScheduledAgentRunNow>(),
  submitAnswer: vi.fn<typeof submitScheduledAgentRunAnswer>(),
  timeZone: vi.fn<typeof readWorkspaceTimeZone>(),
  update: vi.fn<typeof updateScheduledAgentJob>(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  createScheduledAgentJob: services.create,
  getScheduledAgentJob: services.getJob,
  getScheduledAgentRunInput: services.getInput,
  listScheduledAgentJobs: services.list,
  queueScheduledAgentRunNow: services.runNow,
  reportConversations: services.report,
  submitScheduledAgentRunAnswer: services.submitAnswer,
  updateScheduledAgentJob: services.update,
}));
vi.mock("@agent/lib/subscriptions/pilot", () => ({
  subscriptionsPilot: watches.pilot,
}));
vi.mock("@db/services/location", () => ({
  locationPilot: watches.locationPilot,
}));
vi.mock("@db/services/subscriptions", () => ({
  listLiveSubscriptions: watches.list,
  setSubscriptionStatus: watches.setStatus,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: services.timeZone,
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
    services.timeZone.mockResolvedValue("Asia/Yekaterinburg");
    // Reports go back to the chat the schedule was made in, unless a test
    // says the person writes from a messenger elsewhere.
    services.report.mockImplementation((job) =>
      Promise.resolve({
        delivery: {
          conversationChannel: job.conversationChannel,
          conversationId: job.conversationId,
          replyAnchorMessageId: null,
        },
        fallbacks: [],
      })
    );
  });

  // RU d12 (25.09): «сколько ехать до работы на машине» became «во сколько
  // выезжать, чтобы быть к 10:00» in the prompt every morning's run follows.
  it("keeps conditions the person never stated out of a schedule's prompt", () => {
    expect(createSchedule.description).toContain(
      "Add nothing the person did not state: no arrival time («быть к 10:00»)"
    );
    for (const { inputSchema } of [createSchedule, updateSchedule]) {
      if (!(inputSchema instanceof z.ZodType)) {
        throw new TypeError("Expected an authored Zod input schema.");
      }
      expect(JSON.stringify(z.toJSONSchema(inputSchema))).toContain(
        "No condition the person did not state: no arrival time"
      );
    }
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
      "missingInputs",
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
    expect(result).toMatchObject({
      ...scheduleSummary(job),
      deliversTo: "iMessage, this chat",
    });
    expect(result).toHaveProperty(
      "reply",
      expect.stringContaining("iMessage, this chat")
    );
  });

  it("sets a recurring schedule in the person's profile zone when the model names none", async () => {
    services.create.mockImplementation((_scope, input) =>
      Promise.resolve({
        ...scheduledJob(),
        nextRunAt: new Date("2026-09-28T03:00:00.000Z"),
        timing: input.timing,
      })
    );

    const result = await createSchedule.execute(
      {
        missedRunPolicy: "run_latest",
        prompt: "Утренняя сводка.",
        timing: { frequency: "weekdays", kind: "calendar", localTime: "08:00" },
      },
      toolContext("schedules-create")
    );

    expect(services.create).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      expect.objectContaining({
        timing: {
          frequency: "weekdays",
          kind: "calendar",
          localTime: "08:00",
          timezone: "Asia/Yekaterinburg",
        },
      })
    );
    // The reply names Monday 08:00 in Yekaterinburg, not a UTC instant.
    expect(result).toMatchObject({
      nextRunLocal: "2026-09-28 08:00, Monday (Asia/Yekaterinburg)",
    });
  });

  it("turns «напомни завтра в 9» on the person's clock into one instant", async () => {
    services.create.mockImplementation((_scope, input) =>
      Promise.resolve({
        ...scheduledJob(),
        nextRunAt: new Date("2026-09-26T04:00:00.000Z"),
        timing: input.timing,
      })
    );

    const result = await createSchedule.execute(
      {
        missedRunPolicy: "run_latest",
        prompt: "Напомнить позвонить маме.",
        timing: { at: "2026-09-26T09:00", kind: "once" },
      },
      toolContext("schedules-create")
    );

    expect(services.create).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      expect.objectContaining({
        timing: { at: "2026-09-26T04:00:00.000Z", kind: "once" },
      })
    );
    expect(result).toMatchObject({
      nextRunLocal: "2026-09-26 09:00, Saturday (Asia/Yekaterinburg)",
    });
  });

  it("keeps a changed rule in its own zone and off holidays", async () => {
    // «Каждый будний день в 9 по Нью-Йорку, кроме праздников», then
    // «сдвинь на 9:30» sent without the zone or the flag.
    const stored = {
      ...scheduledJob(),
      timing: {
        frequency: "weekdays" as const,
        kind: "calendar" as const,
        localTime: "09:00",
        skipHolidays: true,
        timezone: "America/New_York",
      },
    };
    services.getJob.mockResolvedValue(stored);
    services.update.mockImplementation((_scope, _id, patch) =>
      Promise.resolve({ ...stored, timing: patch.timing ?? stored.timing })
    );

    await updateSchedule.execute(
      {
        id: stored.id,
        timing: { frequency: "weekdays", kind: "calendar", localTime: "09:30" },
      },
      toolContext("schedules-update")
    );

    expect(services.update).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      stored.id,
      {
        timing: {
          frequency: "weekdays",
          kind: "calendar",
          localTime: "09:30",
          skipHolidays: true,
          timezone: "America/New_York",
        },
      }
    );

    // Only an explicit false puts it back on holidays.
    await updateSchedule.execute(
      {
        id: stored.id,
        timing: {
          frequency: "weekdays",
          kind: "calendar",
          localTime: "09:30",
          skipHolidays: false,
        },
      },
      toolContext("schedules-update")
    );
    expect(services.update).toHaveBeenLastCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      stored.id,
      {
        timing: {
          frequency: "weekdays",
          kind: "calendar",
          localTime: "09:30",
          timezone: "America/New_York",
        },
      }
    );
  });

  // RU d12 (25.09): the confirmation of a morning summary said neither where
  // it would arrive, nor how to move or pause it, nor that the drive would be
  // missing until the work address came, and offered no trial run.
  it("tells where a summary arrives, how to change it, and what it lacks", async () => {
    const job = {
      ...scheduledJob({
        conversationChannel: "eve",
        conversationId: "session-1",
      }),
      prompt:
        "Утренняя сводка: события календаря, письма, на которые я не ответил, погода и сколько ехать до работы на машине.",
    };
    services.create.mockResolvedValue(job);
    services.report.mockResolvedValue({
      delivery: {
        conversationChannel: "telegram",
        conversationId: "telegram:dm:42",
        replyAnchorMessageId: null,
      },
      fallbacks: [],
    });

    const result = await createSchedule.execute(
      {
        missedRunPolicy: "run_latest",
        missingInputs: ["адрес работы", ""],
        prompt: job.prompt,
        timing: { frequency: "weekdays", kind: "calendar", localTime: "08:00" },
      },
      toolContext("schedules-create", "test", "eve")
    );

    expect(result).toMatchObject({
      deliversTo:
        "Telegram, the messenger the person last wrote from, not this chat",
    });
    const reply = "reply" in result ? result.reply : "";
    expect(reply).toContain("«сдвинь на 7:30»");
    expect(reply).toContain("«на праздники не присылай»");
    expect(reply).toContain("«поставь на паузу»");
    expect(reply).toContain("schedules-update with runNow true");
    expect(reply).toContain("never «с учётом пробок»");
    expect(reply).toContain("Until the person gives «адрес работы»");
    // An empty entry a model filled in names nothing missing.
    expect(reply).not.toContain("«»");
  });

  it("offers no trial run and no traffic promise for a one-time reminder", async () => {
    const job = {
      ...scheduledJob(),
      prompt: "Напомнить позвонить маме.",
      timing: { at: "2026-09-26T04:00:00.000Z", kind: "once" as const },
    };
    services.create.mockResolvedValue(job);

    const result = await createSchedule.execute(
      {
        missedRunPolicy: "run_latest",
        prompt: job.prompt,
        timing: { at: "2026-09-26T09:00", kind: "once" },
      },
      toolContext("schedules-create")
    );

    const reply = "reply" in result ? result.reply : "";
    expect(reply).toContain("iMessage, this chat");
    expect(reply).not.toContain("runNow");
    expect(reply).not.toContain("сдвинь");
    expect(reply).not.toContain("пробок");
  });

  it.each([
    [
      "Каждый понедельник присылай список новых файлов на моём Google Drive.",
      false,
    ],
    ["Напоминай продлить driver's licence.", false],
    ["Сколько ехать до работы на машине.", true],
  ])(
    "promises map time without traffic only for travel: «%s»",
    async (prompt, travel) => {
      const job = { ...scheduledJob(), prompt };
      services.create.mockResolvedValue(job);

      const result = await createSchedule.execute(
        {
          missedRunPolicy: "run_latest",
          prompt,
          timing: { frequency: "daily", kind: "calendar", localTime: "09:00" },
        },
        toolContext("schedules-create")
      );

      const reply = "reply" in result ? result.reply : "";
      expect(reply.includes("с учётом пробок")).toBe(travel);
    }
  );

  it("names the web chat when the person has no messenger", async () => {
    const job = scheduledJob({
      conversationChannel: "eve",
      conversationId: "session-1",
    });
    services.create.mockResolvedValue(job);

    const result = await createSchedule.execute(
      {
        missedRunPolicy: "run_latest",
        prompt: job.prompt,
        timing: { frequency: "daily", kind: "calendar", localTime: "09:00" },
      },
      toolContext("schedules-create", "test", "eve")
    );

    expect(result).toHaveProperty(
      "deliversTo",
      expect.stringContaining("this web chat")
    );
    // A web schedule is owned by its Eve session.
    expect(services.create).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      expect.objectContaining({
        conversationChannel: "eve",
        conversationId: "session-1",
      })
    );
  });

  it("runs a schedule once now on the person's yes to a trial", async () => {
    const job = scheduledJob();
    services.getJob.mockResolvedValue(job);
    services.runNow.mockResolvedValue({ queued: true, runId: "run-trial" });

    const result = await updateSchedule.execute(
      { id: job.id, runNow: true },
      toolContext("schedules-update")
    );

    // Its regular runs stay as they are: nothing about the schedule changes.
    expect(services.update).not.toHaveBeenCalled();
    expect(services.runNow).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      job.id
    );
    expect(result).toMatchObject(scheduleSummary(job));
    expect(result).toHaveProperty(
      "runNow",
      expect.stringContaining("iMessage, this chat")
    );

    // Asked again while that run is on its way: nothing new starts.
    services.runNow.mockResolvedValue({ queued: false, runId: "run-trial" });
    expect(
      await updateSchedule.execute(
        { id: job.id, runNow: true },
        toolContext("schedules-update")
      )
    ).toHaveProperty("runNow", expect.stringContaining("already on its way"));
  });

  it("runs nothing when the same call pauses or deletes the schedule", async () => {
    const job = { ...scheduledJob(), status: "paused" as const };
    services.update.mockResolvedValue(job);

    const result = await updateSchedule.execute(
      { id: job.id, runNow: true, status: "paused" },
      toolContext("schedules-update")
    );

    expect(services.runNow).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("runNow");
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
    // Times are on the person's clock only, never a UTC instant.
    expect(JSON.stringify(result)).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:/u);
  });

  it("lists, pauses and deletes a price watch, and changes nothing else of it", async () => {
    const created = new Date("2026-10-02T10:00:00.000Z");
    const watch = {
      action: "notify" as const,
      checkEverySeconds: 21_600,
      checks: 3,
      condition: { amount: 8_000, kind: "below" as const },
      createdAt: created,
      createdByUserId: "user-1",
      dedupeKey: "shop.example/p/1",
      expiresAt: new Date("2026-11-01T10:00:00.000Z"),
      failures: 0,
      hits: 0,
      id: "00000000-0000-4000-8000-0000000000aa",
      jobId: "00000000-0000-4000-8000-0000000000ab",
      lastCheckedAt: null,
      lastError: null,
      lastHitAt: null,
      nextCheckAt: new Date("2026-10-02T16:00:00.000Z"),
      source: {
        currency: "RUB",
        extractor: "jsonld" as const,
        landedOn: "shop.example/p/1",
        name: "Чайник",
        sku: null,
        url: "https://shop.example/p/1",
      },
      state: {
        baseline: 8_990,
        last: 8_990,
        lastSeenAt: created.toISOString(),
      },
      status: "active" as const,
      template: "price" as const,
      updatedAt: created,
      wake: "day_only" as const,
      workspaceId: "workspace-1",
    };
    services.list.mockResolvedValue([]);
    watches.list.mockResolvedValue([watch]);
    const listed = await listSchedules.execute(
      {},
      toolContext("schedules-list")
    );
    expect(listed).toEqual([
      expect.objectContaining({ id: watch.id, status: "active" }),
    ]);

    services.update.mockResolvedValue(undefined);
    watches.setStatus.mockResolvedValue({ ...watch, status: "paused" });
    await expect(
      updateSchedule.execute(
        { id: watch.id, status: "paused" },
        toolContext("schedules-update")
      )
    ).resolves.toMatchObject({ id: watch.id, status: "paused" });
    expect(watches.setStatus).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      watch.id,
      "paused"
    );

    watches.setStatus.mockResolvedValue({ ...watch, status: "cancelled" });
    await expect(
      updateSchedule.execute(
        { id: watch.id, status: "deleted" },
        toolContext("schedules-update")
      )
    ).resolves.toMatchObject({ id: watch.id, status: "deleted" });
    expect(watches.setStatus).toHaveBeenLastCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      watch.id,
      "deleted"
    );

    services.getJob.mockResolvedValue(undefined);
    await expect(
      updateSchedule.execute(
        { id: watch.id, runNow: true },
        toolContext("schedules-update")
      )
    ).rejects.toThrow(/can only be paused, resumed or deleted/u);

    // Outside the pilot the tick holds it: it is not resumed, only paused
    // or deleted, and nothing points at a tool the turn does not have.
    watches.pilot.mockResolvedValue(false);
    watches.setStatus.mockClear();
    await expect(
      updateSchedule.execute(
        { id: watch.id, status: "active" },
        toolContext("schedules-update")
      )
    ).rejects.toThrow(/watches are switched off here now/u);
    await expect(
      updateSchedule.execute(
        { id: watch.id, prompt: "ниже 7000" },
        toolContext("schedules-update")
      )
    ).rejects.toThrow(/^(?!.*watch-create).*switched off/u);
    expect(watches.setStatus).not.toHaveBeenCalled();
    watches.setStatus.mockResolvedValue({ ...watch, status: "paused" });
    await expect(
      updateSchedule.execute(
        { id: watch.id, status: "paused" },
        toolContext("schedules-update")
      )
    ).resolves.toMatchObject({ status: "paused" });
    watches.pilot.mockResolvedValue(true);
  });

  it("lists a reminder at a place without its point, and changes only its status", async () => {
    const created = new Date("2026-10-15T10:00:00.000Z");
    const reminder = {
      action: "notify" as const,
      checkEverySeconds: 86_400,
      checks: 0,
      condition: {
        on: "arrive" as const,
        repeat: false,
        text: "забрать посылку",
      },
      createdAt: created,
      createdByUserId: "user-1",
      dedupeKey: "arrive:55.751,37.618",
      expiresAt: new Date("2026-10-29T10:00:00.000Z"),
      failures: 0,
      hits: 0,
      id: "00000000-0000-4000-8000-0000000000ba",
      jobId: "00000000-0000-4000-8000-0000000000bb",
      lastCheckedAt: null,
      lastError: null,
      lastHitAt: null,
      nextCheckAt: new Date("2026-10-29T10:00:00.000Z"),
      source: {
        address: "Тверская улица 7, Москва",
        label: "дом",
        lat: 55.7512,
        lon: 37.6184,
        origin: "home" as const,
        radiusM: 150,
      },
      state: {
        changedAt: null,
        farAt: null,
        inside: null,
        last: null,
        pending: null,
        recentOut: null,
        sawPosition: false,
      },
      status: "active" as const,
      template: "place" as const,
      updatedAt: created,
      wake: "urgent_at_night" as const,
      workspaceId: "workspace-1",
    };
    services.list.mockResolvedValue([]);
    watches.list.mockResolvedValue([reminder]);
    const listed = await listSchedules.execute(
      {},
      toolContext("schedules-list")
    );
    expect(listed).toEqual([
      expect.objectContaining({
        id: reminder.id,
        nextCheckLocal: null,
        place: { label: "дом", radiusM: 150 },
        when: { on: "arrive", text: "забрать посылку" },
      }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/55\.75|Тверская/u);
    services.getJob.mockResolvedValue(undefined);
    await expect(
      updateSchedule.execute(
        { id: reminder.id, runNow: true },
        toolContext("schedules-update")
      )
    ).rejects.toThrow(/place reminder/u);
    watches.locationPilot.mockReturnValueOnce(false);
    await expect(
      updateSchedule.execute(
        { id: reminder.id, status: "active" },
        toolContext("schedules-update")
      )
    ).rejects.toThrow(/geolocation is switched off/u);
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
    delegation: null,
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
    createdIn: job.conversationChannel === "eve" ? "web chat" : "iMessage",
    id: job.id,
    lastError: job.lastError,
    lastRunLocal: null,
    // 13:00 UTC is 09:00 in New York, the rule's own zone.
    nextRunLocal: "2026-09-02 09:00, Wednesday (America/New_York)",
    prompt: job.prompt,
    status: job.status,
    timing: job.timing,
  };
}

function scheduleListSummary(job: ReturnType<typeof scheduledJob>) {
  return { ...scheduleSummary(job), latestRun: null };
}

describe("schedules that act (BACKGROUND_ACTIONS_WORKSPACES)", () => {
  const haircut = {
    kind: "browser" as const,
    site: "https://boroda.example",
    submission: {
      chargeRub: 0,
      forWhom: "Алиса",
      kind: "appointment" as const,
      personalData: ["имя", "телефон"],
      what: "запись на стрижку к Артуру",
      when: "ближайший свободный слот после 18:00",
      where: "барбершоп «Борода» (boroda.example)",
    },
  };
  const timing = {
    frequency: "daily" as const,
    kind: "calendar" as const,
    localTime: "09:00",
    timezone: "Europe/Moscow",
  };

  /** The person's own turn in the chat, in a workspace of the pilot. */
  function personTurn(): DynamicResolveContext {
    const context = dynamicContext("photon-imessage", "channel:photon");
    return {
      ...context,
      session: {
        ...context.session,
        auth: {
          current: {
            ...context.session.auth.current,
            attributes: { workspaceId: "workspace-1" },
          },
          initiator: null,
        },
      },
    };
  }

  async function createTool(pilot: string) {
    vi.resetModules();
    vi.stubEnv("BACKGROUND_ACTIONS_WORKSPACES", pilot);
    const { default: tools } = await import("@agent/tools/schedules");
    const resolve = tools.events["turn.started"];
    const resolved = resolve ? await resolve({}, personTurn()) : null;
    const create =
      resolved && "schedules-create" in resolved
        ? resolved["schedules-create"]
        : undefined;
    if (!create) throw new Error("Expected the schedules-create tool.");
    return create;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    services.timeZone.mockResolvedValue("Europe/Moscow");
    services.report.mockImplementation((job) =>
      Promise.resolve({
        delivery: {
          conversationChannel: job.conversationChannel,
          conversationId: job.conversationId,
          replyAnchorMessageId: null,
        },
        fallbacks: [],
      })
    );
    services.create.mockImplementation((_scope, input) =>
      Promise.resolve({
        ...scheduledJob(),
        delegation: input.delegation ?? null,
      })
    );
  });

  it("keeps the free action the person delegated in their own message", async () => {
    const create = await createTool("workspace-1");
    expect(inputProperties(create.inputSchema)).toContain("delegate");

    const result = await create.execute(
      {
        delegate: haircut,
        missedRunPolicy: "run_latest",
        prompt: "Проверяй свободные слоты к Артуру и запиши на первый.",
        timing,
      },
      toolContext("schedules-create", "photon-imessage")
    );

    expect(services.create.mock.calls[0]?.[1]).toMatchObject({
      delegation: haircut,
    });
    expect(JSON.stringify(result)).toContain(
      "each run does «запись на стрижку к Артуру» on https://boroda.example itself"
    );
  });

  it("keeps nothing from a turn the person did not start", async () => {
    const create = await createTool("workspace-1");

    await expect(
      create.execute(
        {
          delegate: haircut,
          missedRunPolicy: "run_latest",
          prompt: "Запиши на первый свободный слот.",
          timing,
        },
        toolContext("schedules-create", "browser-result")
      )
    ).rejects.toThrow("only from their own message in this turn");
    expect(services.create).not.toHaveBeenCalled();
  });

  it("takes no paid action", async () => {
    const create = await createTool("workspace-1");
    if (!(create.inputSchema instanceof z.ZodType)) {
      throw new TypeError("Expected an authored Zod input schema.");
    }
    const paid = {
      ...haircut,
      submission: { ...haircut.submission, chargeRub: 1500 },
    };

    expect(
      create.inputSchema.safeParse({
        delegate: paid,
        prompt: "Запиши к Артуру.",
        timing,
      }).success
    ).toBe(false);
  });

  it("offers no delegate outside the pilot", async () => {
    const create = await createTool("");

    expect(inputProperties(create.inputSchema)).not.toContain("delegate");
    expect(create.description).toBe(createSchedule.description);
  });
});

// EN D2 (roadmap, item 18): check-in for a flight out of another city came
// as «2026-10-01T09:17» with no zone, and opened on the person's clock.
describe("a one-off on the clock of an event elsewhere (SCHEDULE_EVENT_ZONE_WORKSPACES)", () => {
  async function createTool(pilot: string) {
    vi.resetModules();
    vi.stubEnv("SCHEDULE_EVENT_ZONE_WORKSPACES", pilot);
    const { default: tools } = await import("@agent/tools/schedules");
    const resolve = tools.events["turn.started"];
    const context = dynamicContext("photon-imessage", "channel:photon");
    const resolved = resolve
      ? await resolve(
          {},
          {
            ...context,
            session: {
              ...context.session,
              auth: {
                current: {
                  ...context.session.auth.current,
                  attributes: { workspaceId: "workspace-1" },
                },
                initiator: null,
              },
            },
          }
        )
      : null;
    const create =
      resolved && "schedules-create" in resolved
        ? resolved["schedules-create"]
        : undefined;
    if (!create) throw new Error("Expected the schedules-create tool.");
    return create;
  }

  // The departure as the booking shows it, on the clock of JFK.
  const input = {
    missedRunPolicy: "run_latest" as const,
    prompt: "Открой онлайн-регистрацию на рейс DL 2101 Нью-Йорк — Чикаго.",
    timing: {
      at: "2026-10-02T09:17",
      kind: "once" as const,
      minutesBefore: 1440,
      timezone: "America/New_York",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: new Date("2026-09-25T12:00:00.000Z") });
    services.timeZone.mockResolvedValue("Europe/Moscow");
    services.report.mockImplementation((job) =>
      Promise.resolve({
        delivery: {
          conversationChannel: job.conversationChannel,
          conversationId: job.conversationId,
          replyAnchorMessageId: null,
        },
        fallbacks: [],
      })
    );
    services.create.mockImplementation((_scope, created) =>
      Promise.resolve({
        ...scheduledJob(),
        nextRunAt:
          created.timing.kind === "once" ? new Date(created.timing.at) : null,
        timing: created.timing,
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens check-in 24 h before a New York departure on the airport's clock, for a person in Moscow", async () => {
    const create = await createTool("workspace-1");
    if (!(create.inputSchema instanceof z.ZodType)) {
      throw new TypeError("Expected an authored Zod input schema.");
    }
    expect(create.inputSchema.safeParse(input).success).toBe(true);

    const result = await create.execute(
      input,
      toolContext("schedules-create", "photon-imessage")
    );

    // 09:17 in New York (UTC−4) on 1 October is 13:17 UTC, 16:17 in Moscow.
    expect(services.create.mock.calls[0]?.[1]).toMatchObject({
      timing: { at: "2026-10-01T13:17:00.000Z", kind: "once" },
    });
    expect(result).toMatchObject({
      nextRunEventLocal: "2026-10-01 09:17, Thursday (America/New_York)",
      nextRunLocal: "2026-10-01 16:17, Thursday (Europe/Moscow)",
    });
  });

  it("says check-in is open now rather than set a moment already past", async () => {
    const create = await createTool("workspace-1");
    vi.setSystemTime(new Date("2026-10-01T20:00:00.000Z"));

    await expect(
      create.execute(input, toolContext("schedules-create", "photon-imessage"))
    ).rejects.toThrow("check-in is already open");
    expect(services.create).not.toHaveBeenCalled();
  });
});
