import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Session } from "eve/channels";
import type { ScheduleHandlerArgs, ScheduleToFn } from "eve/schedules";
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
import {
  claimDueProactiveWatches,
  queueProactiveRun,
  recordProactiveTarget,
} from "@db/services/proactive";
import {
  claimReadyScheduledAgentRuns,
  completeScheduledAgentRun,
  createScheduledAgentJob,
  finalizeScheduledReport,
} from "@db/services/scheduled-agent-jobs";
import dynamicSchedule from "@agent/schedules/dynamic";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

// The real `dynamic` tick runs against a real schema; only the channels it
// hands work to and the credit check stay outside.
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
const telegram = {
  conversationChannel: "telegram" as const,
  conversationId: "100::",
};
const photon = {
  conversationChannel: "photon" as const,
  conversationId: "imessage:chat-alice",
};
const web = {
  conversationChannel: "eve" as const,
  conversationId: "web-session-alice",
};
const newerWeb = {
  conversationChannel: "eve" as const,
  conversationId: "web-session-alice-2",
};
// Midday in the default zone: quiet hours would hold a proactive report back.
const now = new Date("2026-09-23T12:00:00.000Z");

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 30_000);

beforeEach(async () => {
  await database.delete(schema.workspaces);
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

describe("reports reach the web chat", () => {
  it("writes first into the web chat of a person with no messenger", async () => {
    expect(await recordProactiveTarget(alice, web, now)).toBe("created");
    const runId = await completedFlightCheck();

    const delivery = reportDelivery();
    await runDynamicTick(delivery);

    expect(delivery.to).not.toHaveBeenCalled();
    expect(delivery.attachSession).toHaveBeenCalledExactlyOnceWith(
      web.conversationId
    );
    const [prompt, options] = delivery.send.mock.calls[0] ?? [];
    const text = z.string().parse(prompt);
    expect(text.startsWith(backgroundTurnMarker)).toBe(true);
    expect(text).toContain("Nobody asked for this check");
    expect(text).toContain("SU 1234");
    const attributes = options?.auth?.attributes;
    expect(attributes).toMatchObject({
      conversationChannel: "eve",
      conversationId: web.conversationId,
      scheduledRunId: runId,
    });

    // While the report turn runs, the next tick does not send it again.
    const again = reportDelivery();
    await runDynamicTick(again);
    expect(again.send).not.toHaveBeenCalled();

    // The web chat's `send_message` result settles the report.
    const leaseToken = z.uuid().parse(attributes?.scheduledReportLeaseToken);
    expect(await finalizeScheduledReport(runId, leaseToken, "delivered")).toBe(
      true
    );
  });

  it("delivers a scheduled task's result into the web chat it was set up in", async () => {
    // The person wrote from the web chat and set the task up there.
    await recordProactiveTarget(alice, web, now);
    await completedTask(web, "The price fell to $95.");

    const delivery = reportDelivery();
    await runDynamicTick(delivery);

    expect(delivery.to).not.toHaveBeenCalled();
    expect(delivery.attachSession).toHaveBeenCalledExactlyOnceWith(
      web.conversationId
    );
    const prompt = delivery.send.mock.calls[0]?.[0];
    const text = z.string().parse(prompt);
    expect(text.startsWith(backgroundTurnMarker)).toBe(true);
    expect(text).toContain("A background scheduled run has completed.");
    expect(text).toContain("The price fell to $95.");
  });
});

describe("a messenger wins over the web chat", () => {
  it("keeps writing first to Telegram after the person opened the web chat", async () => {
    expect(await recordProactiveTarget(alice, telegram, now)).toBe("created");
    // One visit to the web chat must not take the pushes away.
    expect(await recordProactiveTarget(alice, web, now)).toBe("remembered");
    await completedFlightCheck();

    const delivery = reportDelivery();
    await runDynamicTick(delivery);

    expect(delivery.attachSession).not.toHaveBeenCalled();
    expect(delivery.to).toHaveBeenCalledExactlyOnceWith(
      { channel: "telegram" },
      { chatId: "100" }
    );
    expect(
      z.string().parse(delivery.messengerSend.mock.calls[0]?.[0])
    ).toContain("SU 1234");
  });

  it("moves to the messenger the person starts using, and stays there", async () => {
    expect(await recordProactiveTarget(alice, web, now)).toBe("created");
    expect(await recordProactiveTarget(alice, telegram, now)).toBe("moved");
    expect(await recordProactiveTarget(alice, newerWeb, now)).toBe(
      "remembered"
    );
    expect(await recordProactiveTarget(alice, newerWeb, now)).toBe("unchanged");
    // Among messengers, the one written from last.
    expect(await recordProactiveTarget(alice, photon, now)).toBe("moved");

    const watch = await database.query.proactiveWatches.findFirst({
      with: { job: true },
    });
    expect(watch).toMatchObject({
      job: { ...photon, kind: "proactive" },
      messengerChannel: "photon",
      messengerConversationId: photon.conversationId,
      webConversationId: newerWeb.conversationId,
    });
  });

  it("sends a reminder set up in the web chat to the person's messenger", async () => {
    await recordProactiveTarget(alice, telegram, now);
    await recordProactiveTarget(alice, web, now);
    await completedTask(web, "Пора выпить таблетку.", "web-message");

    const delivery = reportDelivery();
    await runDynamicTick(delivery);

    expect(delivery.attachSession).not.toHaveBeenCalled();
    expect(delivery.to).toHaveBeenCalledExactlyOnceWith(
      { channel: "telegram" },
      { chatId: "100" }
    );
    const [prompt, options] = delivery.messengerSend.mock.calls[0] ?? [];
    expect(prompt).toContain("Пора выпить таблетку.");
    // The web chat's reply anchor means nothing in Telegram.
    expect(prompt).toContain("No reply handle is available");
    expect(options?.auth?.attributes).toMatchObject({
      conversationChannel: "telegram",
      conversationId: telegram.conversationId,
    });
  });

  it("sends a reminder set up in iMessage to the Telegram chat the person uses now, never to the web", async () => {
    await recordProactiveTarget(alice, photon, now);
    await recordProactiveTarget(alice, telegram, now);
    await recordProactiveTarget(alice, web, now);
    await completedTask(photon, "Пора выпить таблетку.", "imessage-message");

    const delivery = reportDelivery();
    await runDynamicTick(delivery);

    expect(delivery.attachSession).not.toHaveBeenCalled();
    expect(delivery.to).toHaveBeenCalledExactlyOnceWith(
      { channel: "telegram" },
      { chatId: "100" }
    );
    expect(
      delivery.messengerSend.mock.calls[0]?.[1]?.auth?.attributes
    ).not.toHaveProperty("photonReplyAnchorMessageId");
  });
});

describe("a report outlives the web chat it was meant for", () => {
  it("falls back to the web chat the schedule was set up in", async () => {
    await recordProactiveTarget(alice, web, now);
    const runId = await completedTask(web, "Пора выпить таблетку.", "anchor");
    // The person started a new web chat since, and it has ended too.
    await recordProactiveTarget(alice, newerWeb, now);

    const delivery = reportDelivery({
      [newerWeb.conversationId]: "ended",
      [web.conversationId]: "accepted",
    });
    await runDynamicTick(delivery);

    expect(delivery.attachSession.mock.calls).toEqual([
      [newerWeb.conversationId],
      [web.conversationId],
    ]);
    const [prompt, options] = delivery.send.mock.calls[1] ?? [];
    // Back in its own chat, the report may reply to the original message.
    expect(prompt).toContain("Reply handle");
    expect(options?.auth?.attributes).toMatchObject({
      conversationChannel: "eve",
      conversationId: web.conversationId,
    });
    expect(await reportStatus(runId)).toBe("queued");
  });

  it("suppresses the report only once every chat it could go to has ended", async () => {
    await recordProactiveTarget(alice, web, now);
    const runId = await completedTask(web, "Пора выпить таблетку.");
    await recordProactiveTarget(alice, newerWeb, now);

    const delivery = reportDelivery({
      [newerWeb.conversationId]: "ended",
      [web.conversationId]: "ended",
    });
    await runDynamicTick(delivery);

    expect(delivery.attachSession).toHaveBeenCalledTimes(2);
    expect(await reportStatus(runId)).toBe("suppressed");
  });

  it("waits for a web chat that is still starting instead of skipping it", async () => {
    await recordProactiveTarget(alice, web, now);
    const runId = await completedTask(web, "Пора выпить таблетку.");
    await recordProactiveTarget(alice, newerWeb, now);

    const delivery = reportDelivery({
      [newerWeb.conversationId]: "starting",
      [web.conversationId]: "accepted",
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runDynamicTick(delivery);

    expect(delivery.attachSession).toHaveBeenCalledExactlyOnceWith(
      newerWeb.conversationId
    );
    expect(await reportStatus(runId)).toBe("pending");
  });
});

/** A proactive check that found a «flight tomorrow» mail, run and finished. */
async function completedFlightCheck() {
  const [watch] = await claimDueProactiveWatches({
    leaseForMs: 15 * 60_000,
    limit: 10,
    now,
  });
  if (!watch) throw new Error("Expected a due watch.");
  const queued = await queueProactiveRun({
    jobId: watch.jobId,
    mailCheckedAt: now,
    maxRunsPerDay: 12,
    now,
    signals: [
      {
        dedupeKey: "m-flight",
        itemId: "m-flight",
        source: "gmail",
        threadId: "t-flight",
      },
    ],
    workspaceId: alice.workspaceId,
  });
  const [claim] = await claimReadyScheduledAgentRuns({
    kind: "proactive",
    leaseForMs: 60_000,
    limit: 10,
    now,
  });
  if (queued.status !== "queued" || !claim?.run.leaseToken) {
    throw new Error("Expected a claimed proactive run.");
  }
  await completeScheduledAgentRun(
    queued.runId,
    claim.run.leaseToken,
    "turn-1",
    {
      kind: "result",
      summary: "Рейс SU 1234 завтра в 07:40, регистрация открыта.",
      urgency: "time_sensitive",
    },
    now
  );
  return queued.runId;
}

/** A one-off task set up in `conversation`, run by its worker and finished. */
async function completedTask(
  conversation: typeof telegram | typeof photon | typeof web,
  summary: string,
  replyAnchorMessageId?: string
) {
  const job = await createScheduledAgentJob(
    alice,
    {
      ...conversation,
      missedRunPolicy: "run_latest",
      prompt: "Напомнить про таблетку.",
      replyAnchorMessageId,
      timing: {
        at: new Date(now.getTime() + 60_000).toISOString(),
        kind: "once",
      },
    },
    now
  );
  vi.setSystemTime(new Date(now.getTime() + 2 * 60_000));
  const workerSend = vi
    .fn<ReturnType<ScheduleToFn>["send"]>()
    .mockResolvedValue(session("worker-session"));
  const dispatch = {
    attachSession: vi.fn<ScheduleHandlerArgs["attachSession"]>(),
    to: vi.fn<ScheduleToFn>(() => ({ send: workerSend })),
  };
  await runDynamicTick(dispatch);
  expect(dispatch.to).toHaveBeenCalledExactlyOnceWith(
    { channel: "scheduled-run" },
    expect.anything()
  );
  const run = await database.query.scheduledAgentRuns.findFirst({
    where: eq(schema.scheduledAgentRuns.jobId, job.id),
  });
  if (!run?.leaseToken) throw new Error("Expected a leased run.");
  await completeScheduledAgentRun(run.id, run.leaseToken, "turn-1", {
    kind: "result",
    summary,
    urgency: "normal",
  });
  return run.id;
}

async function reportStatus(runId: string) {
  const run = await database.query.scheduledAgentRuns.findFirst({
    where: eq(schema.scheduledAgentRuns.id, runId),
  });
  return run?.reportStatus;
}

/**
 * The handles a schedule tick gets, recording what reached each channel. Each
 * web chat session answers as `webChats` says; any other is live.
 */
function reportDelivery(
  webChats: Record<string, "accepted" | "ended" | "starting"> = {}
) {
  const send = vi.fn<Session["send"]>();
  const messengerSend = vi
    .fn<ReturnType<ScheduleToFn>["send"]>()
    .mockResolvedValue(session("messenger-session"));
  return {
    attachSession: vi
      .fn<ScheduleHandlerArgs["attachSession"]>()
      .mockImplementation((id) => {
        const state = webChats[id] ?? "accepted";
        send.mockResolvedValueOnce(
          state === "accepted"
            ? { sessionId: id, status: "accepted" }
            : {
                retryable: state === "starting",
                status: "session_not_active",
              }
        );
        return session(id, send);
      }),
    messengerSend,
    send,
    to: vi.fn<ScheduleToFn>(() => ({ send: messengerSend })),
  };
}

async function runDynamicTick(
  delivery: Pick<ScheduleHandlerArgs, "attachSession" | "to">
) {
  const tasks: Promise<unknown>[] = [];
  dynamicSchedule.run({
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession: delivery.attachSession,
    to: delivery.to,
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
