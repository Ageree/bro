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
const web = {
  conversationChannel: "eve" as const,
  conversationId: "web-session-alice",
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
  it("writes first into the web chat the person last talked from", async () => {
    await recordProactiveTarget(alice, telegram, now);
    expect(await recordProactiveTarget(alice, web, now)).toBe("moved");
    const [watch] = await claimDueProactiveWatches({
      leaseForMs: 15 * 60_000,
      limit: 10,
      now,
    });
    if (!watch) throw new Error("Expected a due watch.");
    // The check found a «flight tomorrow» mail nobody asked about.
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
      scheduledRunId: queued.runId,
    });

    // While the report turn runs, the next tick does not send it again.
    const again = reportDelivery();
    await runDynamicTick(again);
    expect(again.send).not.toHaveBeenCalled();

    // The web chat's `send_message` result settles the report.
    const leaseToken = z.uuid().parse(attributes?.scheduledReportLeaseToken);
    expect(
      await finalizeScheduledReport(queued.runId, leaseToken, "delivered")
    ).toBe(true);
  });

  it("delivers a scheduled task's result into the web chat it was set up in", async () => {
    // The person wrote from the web chat and set the task up there.
    await recordProactiveTarget(alice, web, now);
    const job = await createScheduledAgentJob(
      alice,
      {
        ...web,
        missedRunPolicy: "run_latest",
        prompt: "Watch the price.",
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
    const dispatch = reportDelivery(workerSend);
    await runDynamicTick(dispatch);
    expect(dispatch.to).toHaveBeenCalledOnce();
    const run = await database.query.scheduledAgentRuns.findFirst({
      where: eq(schema.scheduledAgentRuns.jobId, job.id),
    });
    if (!run?.leaseToken) throw new Error("Expected a leased run.");
    await completeScheduledAgentRun(run.id, run.leaseToken, "turn-1", {
      kind: "result",
      summary: "The price fell to $95.",
      urgency: "normal",
    });

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

/** The handles a schedule tick gets, recording what reached each channel. */
function reportDelivery(
  workerSend = vi.fn<ReturnType<ScheduleToFn>["send"]>()
) {
  const send = vi
    .fn<Session["send"]>()
    .mockResolvedValue({ sessionId: web.conversationId, status: "accepted" });
  return {
    attachSession: vi
      .fn<ScheduleHandlerArgs["attachSession"]>()
      .mockReturnValue(session(web.conversationId, send)),
    send,
    to: vi.fn<ScheduleToFn>(() => ({ send: workerSend })),
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
