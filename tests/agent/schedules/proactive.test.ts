import type { Session } from "eve/channels";
import type { ScheduleHandlerArgs, ScheduleToFn } from "eve/schedules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { probeGoogleSignals, rankMail } from "@agent/lib/proactive/probe";
import type {
  advanceProactiveWatermark,
  claimDueProactiveWatches,
  deferProactiveWatch,
  filterUnseenProactiveSignals,
  listProactiveRunSignals,
  pruneProactiveSignals,
  queueProactiveRun,
} from "@db/services/proactive";
import type {
  claimReadyScheduledAgentRuns,
  releaseScheduledAgentRun,
  setScheduledRunSession,
} from "@db/services/scheduled-agent-jobs";
import type { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import type * as flightModule from "@agent/lib/subscriptions/flight";
import type {
  listFlightWatches,
  listLiveFlightWatches,
  recordFlightWatch,
  syncFlightWatches,
} from "@db/services/subscriptions";
import type { readUserProfile } from "@db/services/user-profile";
import { emptyUserProfile } from "@shared/user-profile/schema";

const proactive = vi.hoisted(() => ({
  advance: vi.fn<typeof advanceProactiveWatermark>(),
  claimWatches: vi.fn<typeof claimDueProactiveWatches>(),
  defer: vi.fn<typeof deferProactiveWatch>(),
  filterUnseen: vi.fn<typeof filterUnseenProactiveSignals>(),
  listSignals: vi.fn<typeof listProactiveRunSignals>(),
  prune: vi.fn<typeof pruneProactiveSignals>(),
  queue: vi.fn<typeof queueProactiveRun>(),
}));
const jobs = vi.hoisted(() => ({
  claimRuns: vi.fn<typeof claimReadyScheduledAgentRuns>(),
  releaseRun: vi.fn<typeof releaseScheduledAgentRun>(),
  setSession: vi.fn<typeof setScheduledRunSession>(),
}));
const probe = vi.hoisted(() => vi.fn<typeof probeGoogleSignals>());
const rank = vi.hoisted(() => vi.fn<typeof rankMail>());
const profile = vi.hoisted(() => vi.fn<typeof readUserProfile>());
const flights = vi.hoisted(() => ({
  drive: vi.fn<typeof flightModule.measureDrive>(),
  list: vi.fn<typeof listFlightWatches>(() => Promise.resolve([])),
  live: vi.fn<typeof listLiveFlightWatches>(() => Promise.resolve([])),
  pilot: vi.fn<typeof subscriptionsPilot>(() => Promise.resolve(false)),
  record: vi.fn<typeof recordFlightWatch>(),
  sync: vi.fn<typeof syncFlightWatches>(),
}));

vi.mock("@db/services/proactive", () => ({
  advanceProactiveWatermark: proactive.advance,
  claimDueProactiveWatches: proactive.claimWatches,
  deferProactiveWatch: proactive.defer,
  filterUnseenProactiveSignals: proactive.filterUnseen,
  listProactiveRunSignals: proactive.listSignals,
  pruneProactiveSignals: proactive.prune,
  queueProactiveRun: proactive.queue,
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  claimReadyScheduledAgentRuns: jobs.claimRuns,
  releaseScheduledAgentRun: jobs.releaseRun,
  setScheduledRunSession: jobs.setSession,
}));
vi.mock("@agent/lib/proactive/probe", () => ({
  // Says which failure it was handed, so the log line is seen to carry it.
  probeFailure: (cause: unknown) => ({
    by: cause instanceof Error ? cause.message : "unknown",
  }),
  probeGoogleSignals: probe,
  rankMail: rank,
}));
vi.mock("@db/services/user-profile", () => ({ readUserProfile: profile }));
vi.mock("@agent/lib/subscriptions/pilot", () => ({
  subscriptionsPilot: flights.pilot,
}));
vi.mock("@db/services/subscriptions", () => ({
  listFlightWatches: flights.list,
  listLiveFlightWatches: flights.live,
  recordFlightWatch: flights.record,
  syncFlightWatches: flights.sync,
}));
vi.mock("@agent/lib/subscriptions/flight", async (importOriginal) => ({
  ...(await importOriginal<typeof flightModule>()),
  measureDrive: flights.drive,
}));
vi.mock("@agent/channels/scheduled-run", () => ({
  default: { channel: "scheduled-run" },
}));

import proactiveSchedule from "@agent/schedules/proactive";

// 15:00 in Moscow: outside quiet hours.
const afternoon = new Date("2026-09-23T12:00:00.000Z");
/** The calendar read covered 26 hours ahead. */
const seenUntil = new Date("2026-09-24T14:00:00.000Z");
const flight = {
  dedupeKey: "flight@2026-09-24T07:40:00+03:00",
  itemId: "flight",
  source: "calendar" as const,
  threadId: null,
};

describe("proactive schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: afternoon, toFake: ["Date"] });
    proactive.claimWatches.mockResolvedValue([watch()]);
    proactive.filterUnseen.mockImplementation((_workspaceId, candidates) =>
      Promise.resolve([...candidates])
    );
    proactive.queue.mockResolvedValue({
      runId: "00000000-0000-4000-8000-000000000002",
      status: "queued",
    });
    jobs.claimRuns.mockResolvedValue([]);
    jobs.setSession.mockResolvedValue(true);
    profile.mockResolvedValue({
      ...emptyUserProfile,
      addressLine1: "ул. Профсоюзная, 12",
      city: "Москва",
      timezone: "Europe/Moscow",
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    flights.pilot.mockResolvedValue(false);
    flights.list.mockResolvedValue([]);
    flights.live.mockResolvedValue([]);
    flights.sync.mockResolvedValue({ ended: 0, started: 0 });
    flights.drive.mockResolvedValue({
      from: "home",
      kind: "drive",
      km: 31.4,
      minutes: 42,
      to: "Внуково",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues one run with the new signals and moves the watermark", async () => {
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [flight],
      state: "connected",
    });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(probe).toHaveBeenCalledExactlyOnceWith(
      { userId: "better-auth:alice", workspaceId: "workspace:alice" },
      {
        flightReminders: true,
        mailAfter: new Date("2026-09-23T11:35:00.000Z"),
        now: afternoon,
        timeZone: "Europe/Moscow",
      }
    );
    expect(proactive.queue).toHaveBeenCalledExactlyOnceWith({
      jobId: "00000000-0000-4000-8000-000000000001",
      mailCheckedAt: afternoon,
      maxRunsPerDay: 12,
      now: afternoon,
      signals: [flight],
      workspaceId: "workspace:alice",
    });
    expect(proactive.advance).not.toHaveBeenCalled();
    // One line per check says what it came to.
    expect(console.info).toHaveBeenCalledWith("[proactive] check", {
      night: false,
      outcome: "queued",
      signalCount: 1,
      workspaceId: "workspace:alice",
    });
    expect(jobs.claimRuns).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "proactive" })
    );
  });

  it("turns a night's backlog into one run with what matters first, and logs what it left out", async () => {
    // 08:00 in Moscow: the first check after the night reads all of it.
    const morning = new Date("2026-09-24T05:00:00.000Z");
    vi.setSystemTime(morning);
    // Newest first: sixteen newsletters overnight, then the evening's parcel
    // notice and a letter from someone the person knows.
    const mail = [
      ...Array.from({ length: 16 }, (_, index) => `news${String(index)}`),
      "parcel",
      "boss",
    ].map((id) => ({
      dedupeKey: id,
      itemId: id,
      source: "gmail" as const,
      threadId: id,
    }));
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: mail,
      state: "connected",
    });
    rank.mockResolvedValue(
      new Map([
        ...mail.map(({ itemId }) => [itemId, 3] as const),
        ["parcel", 0],
        ["boss", 1],
      ])
    );

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(rank).toHaveBeenCalledExactlyOnceWith(
      { userId: "better-auth:alice", workspaceId: "workspace:alice" },
      mail
    );
    const queued = proactive.queue.mock.calls[0]?.[0];
    expect(queued?.signals).toHaveLength(12);
    expect(queued?.signals.slice(0, 3).map(({ itemId }) => itemId)).toEqual([
      "parcel",
      "boss",
      "news0",
    ]);
    expect(queued?.mailCheckedAt).toEqual(morning);
    expect(console.info).toHaveBeenCalledWith("[proactive] check", {
      droppedMail: 6,
      night: false,
      outcome: "queued",
      signalCount: 18,
      workspaceId: "workspace:alice",
    });
  });

  it("does not rank mail that fits one run", async () => {
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [flight],
      state: "connected",
    });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(rank).not.toHaveBeenCalled();
  });

  it("queues a flight reminder that is due even when nothing else is new", async () => {
    // 19:00 in Moscow the evening before a 07:05 flight the checks saw at noon.
    const evening = new Date("2026-09-23T16:00:00.000Z");
    vi.setSystemTime(evening);
    const seen = {
      ...flight,
      dedupeKey: "flight@2026-09-24T07:05:00+03:00",
    };
    const reminder = {
      ...flight,
      dedupeKey: "flight@2026-09-24T07:05:00+03:00#evening",
    };
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [seen, reminder],
      state: "connected",
    });
    proactive.filterUnseen.mockResolvedValue([reminder]);

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.queue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ now: evening, signals: [reminder] })
    );
  });

  it("starts no model run when every signal was already handled", async () => {
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [flight],
      state: "connected",
    });
    proactive.filterUnseen.mockResolvedValue([]);

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.queue).not.toHaveBeenCalled();
    expect(proactive.advance).toHaveBeenCalledExactlyOnceWith(
      "workspace:alice",
      afternoon
    );
  });

  it("looks only for what cannot wait at night and keeps the watermark", async () => {
    // 23:30 in Moscow.
    const night = new Date("2026-09-23T20:30:00.000Z");
    vi.setSystemTime(night);
    proactive.claimWatches.mockResolvedValue([
      { ...watch(), leaseUntil: new Date("2026-09-23T20:45:00.000Z") },
    ]);
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [flight],
      state: "connected",
    });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(probe).toHaveBeenCalledExactlyOnceWith(
      { userId: "better-auth:alice", workspaceId: "workspace:alice" },
      {
        flightReminders: true,
        // Subjects only of mail since the previous night check, not of
        // everything since the evening watermark again.
        mailAfter: new Date("2026-09-23T20:05:00.000Z"),
        nightOnly: true,
        now: night,
        timeZone: "Europe/Moscow",
      }
    );
    expect(proactive.queue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        // The rest of the night's mail is read in the morning as one batch.
        mailCheckedAt: new Date("2026-09-23T11:45:00.000Z"),
        signals: [flight],
      })
    );
    expect(proactive.advance).not.toHaveBeenCalled();
    // The lease already ends before the morning, so the check keeps it.
    expect(proactive.defer).not.toHaveBeenCalled();
  });

  it("runs the last night check into the first morning one", async () => {
    // 07:50 in Moscow; the lease would end at 08:05.
    vi.setSystemTime(new Date("2026-09-24T04:50:00.000Z"));
    const leased = {
      ...watch(),
      leaseUntil: new Date("2026-09-24T05:05:00.000Z"),
    };
    proactive.claimWatches.mockResolvedValue([leased]);
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [],
      state: "connected",
    });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.queue).not.toHaveBeenCalled();
    expect(proactive.defer).toHaveBeenCalledExactlyOnceWith(
      leased,
      new Date("2026-09-24T05:00:00.000Z")
    );
  });

  it("backs off for hours when Google is not connected", async () => {
    probe.mockResolvedValue({ state: "disconnected" });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.defer).toHaveBeenCalledExactlyOnceWith(
      watch(),
      new Date("2026-09-23T18:00:00.000Z"),
      "disconnected"
    );
    expect(proactive.queue).not.toHaveBeenCalled();
  });

  it("keeps checking other workspaces when one probe fails", async () => {
    proactive.claimWatches.mockResolvedValue([
      watch(),
      { ...watch(), workspaceId: "workspace:bob" },
    ]);
    probe
      .mockRejectedValueOnce(new Error("Gmail is down"))
      .mockResolvedValueOnce({
        calendarSeenUntil: seenUntil,
        flights: [],
        signals: [flight],
        state: "connected",
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.queue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: "workspace:bob" })
    );
    // The log line names the failure, so a Composio 403 is told from Google.
    expect(warn).toHaveBeenCalledWith(
      "[proactive] check",
      expect.objectContaining({
        failure: { by: "Gmail is down" },
        outcome: "failed",
      })
    );
  });

  it("keeps a watch per flight in the pilot, and hands its due reminder over with the run", async () => {
    flights.pilot.mockResolvedValue(true);
    flights.sync.mockResolvedValue({ ended: 0, started: 1 });
    flights.live.mockResolvedValue([flightWatchRow()]);
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [dp405],
      signals: [mailSignal],
      state: "connected",
    });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(probe).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ flightReminders: false })
    );
    expect(flights.sync).toHaveBeenCalledExactlyOnceWith({
      flights: [dp405],
      now: afternoon,
      scope: { userId: "better-auth:alice", workspaceId: "workspace:alice" },
      seenUntil,
    });
    // Check-in opened at 07:05 today: it goes with the run, keyed as the
    // check's own reminder, with the mail.
    expect(proactive.queue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        signals: [checkinSignal, mailSignal],
      })
    );
    // The drive is measured once, for the reminder that goes, and then the
    // watch remembers it went.
    expect(flights.drive).toHaveBeenCalledOnce();
    expect(flights.record.mock.lastCall).toMatchObject([
      "watch-1",
      { done: ["checkin"], travel: { minutes: 42 } },
      afternoon,
    ]);
    expect(console.info).toHaveBeenCalledWith(
      "[proactive] check",
      expect.objectContaining({ flights: { ended: 0, started: 1 } })
    );
  });

  it("never lets a full run cut a flight's reminder, nor marks one it did not carry", async () => {
    flights.pilot.mockResolvedValue(true);
    flights.live.mockResolvedValue([flightWatchRow()]);
    // A reconnect: more new events than one run carries.
    const events = Array.from({ length: 13 }, (_, index) => ({
      dedupeKey: `event${String(index)}`,
      itemId: `event${String(index)}`,
      source: "calendar" as const,
      threadId: null,
    }));
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: events,
      state: "connected",
    });

    await runSchedule(vi.fn<ScheduleToFn>());

    const queued = proactive.queue.mock.calls[0]?.[0];
    expect(queued?.signals).toHaveLength(12);
    expect(queued?.signals[0]).toEqual(checkinSignal);
    expect(flights.record.mock.lastCall).toMatchObject([
      "watch-1",
      { done: ["checkin"] },
      afternoon,
    ]);

    // Thirteen flights due at once: the run carries twelve, and the
    // thirteenth stays due for the next check instead of being marked done.
    flights.record.mockClear();
    flights.live.mockResolvedValue(
      Array.from({ length: 13 }, (_, index) => ({
        ...flightWatchRow(),
        id: `watch-${String(index)}`,
        source: { ...dp405, eventId: `flight${String(index)}` },
      }))
    );
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [],
      state: "connected",
    });
    await runSchedule(vi.fn<ScheduleToFn>());
    expect(proactive.queue.mock.lastCall?.[0].signals).toHaveLength(12);
    // The drive is written for each, the reminder only for those carried.
    expect(
      flights.record.mock.calls
        .filter(([, state]) => state.done.length > 0)
        .map(([id]) => id)
    ).toEqual(
      Array.from({ length: 12 }, (_, index) => `watch-${String(index)}`)
    );
  });

  it("keeps a flight's reminder due while the job is busy, and measures nothing for one already sent", async () => {
    flights.pilot.mockResolvedValue(true);
    flights.live.mockResolvedValue([flightWatchRow()]);
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [],
      state: "connected",
    });
    proactive.queue.mockResolvedValue({ status: "busy" });

    await runSchedule(vi.fn<ScheduleToFn>());
    // Only the drive was written: the reminder is still due.
    expect(flights.record).toHaveBeenCalledOnce();
    expect(flights.record.mock.calls[0]).toMatchObject([
      "watch-1",
      { done: [], travel: { kind: "drive" } },
      afternoon,
    ]);

    // A run had it before: it is marked, nothing is measured or queued.
    flights.record.mockClear();
    flights.drive.mockClear();
    proactive.queue.mockClear();
    proactive.filterUnseen.mockResolvedValue([]);
    await runSchedule(vi.fn<ScheduleToFn>());
    expect(proactive.queue).not.toHaveBeenCalled();
    expect(flights.drive).not.toHaveBeenCalled();
    expect(flights.record).toHaveBeenCalledExactlyOnceWith(
      "watch-1",
      { done: ["checkin"] },
      afternoon
    );
  });

  it("goes on checking when the flight watches cannot be kept", async () => {
    flights.pilot.mockResolvedValue(true);
    flights.sync.mockRejectedValue(new Error("database down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [flight],
      state: "connected",
    });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.queue).toHaveBeenCalledOnce();
  });

  it("holds the evening's ordinary mail for the morning from 21:00 in the pilot", async () => {
    // 21:30 in Moscow.
    const evening = new Date("2026-09-23T18:30:00.000Z");
    vi.setSystemTime(evening);
    proactive.claimWatches.mockResolvedValue([
      { ...watch(), leaseUntil: new Date("2026-09-23T18:45:00.000Z") },
    ]);
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [],
      state: "connected",
    });

    flights.pilot.mockResolvedValue(false);
    await runSchedule(vi.fn<ScheduleToFn>());
    expect(probe).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ nightOnly: true })
    );

    flights.pilot.mockResolvedValue(true);
    await runSchedule(vi.fn<ScheduleToFn>());
    // Only what cannot wait starts a run; the watermark stays for the
    // morning, which reads the whole evening as one batch.
    expect(probe).toHaveBeenLastCalledWith(
      expect.anything(),
      // An event within hours or important mail still starts a run.
      expect.objectContaining({
        evening: true,
        // An hour back: an urgent letter a busy job left is read again.
        mailAfter: new Date("2026-09-23T17:30:00.000Z"),
        nightOnly: true,
      })
    );
    expect(proactive.advance).toHaveBeenCalledOnce();
    expect(proactive.defer).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenLastCalledWith(
      "[proactive] check",
      expect.objectContaining({ evening: true, night: false })
    );
  });

  it("gives the worker the times a flight's watch counted", async () => {
    flights.pilot.mockResolvedValue(true);
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [],
      state: "connected",
    });
    proactive.listSignals.mockResolvedValue([
      { ...flight, dedupeKey: `${flight.dedupeKey}#evening` },
    ]);
    flights.list.mockResolvedValue([
      {
        condition: { kind: "reminders" },
        source: {
          eventId: "flight",
          location: "Аэропорт Внуково",
          start: "2026-09-24T07:40:00+03:00",
          summary: "Рейс DP 405",
          timeZone: "Europe/Moscow",
        },
        state: {
          done: ["evening"],
          travel: {
            from: "home",
            kind: "drive",
            km: 31.4,
            minutes: 42,
            to: "Внуково",
          },
        },
        template: "flight",
      },
    ]);
    jobs.claimRuns.mockResolvedValue([proactiveClaim()]);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());

    await runSchedule(vi.fn<ScheduleToFn>(() => ({ send })));

    expect(flights.list).toHaveBeenCalledExactlyOnceWith("workspace:alice", [
      "flight",
    ]);
    expect(send.mock.calls[0]?.[0]).toContain(
      "Counted by code from the calendar (estimates where they say so): Departs 2026-09-24 07:40, Thursday (Europe/Moscow)."
    );
    expect(send.mock.calls[0]?.[0]).toContain(
      "A leave-by estimate: about 2026-09-24 04:58"
    );

    // Outside the pilot the check reminds by itself: no watch is read.
    flights.pilot.mockResolvedValue(false);
    flights.list.mockClear();
    await runSchedule(vi.fn<ScheduleToFn>(() => ({ send })));
    expect(flights.list).not.toHaveBeenCalled();
  });

  it("dispatches a claimed run as a proactive worker with its signals", async () => {
    probe.mockResolvedValue({
      calendarSeenUntil: seenUntil,
      flights: [],
      signals: [],
      state: "connected",
    });
    proactive.listSignals.mockResolvedValue([flight]);
    const claim = proactiveClaim();
    jobs.claimRuns.mockResolvedValue([claim]);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(to).toHaveBeenCalledWith(expect.anything(), {
      restart: false,
      runId: claim.run.id,
    });
    expect(send.mock.calls[0]?.[0]).toContain("these ids): flight");
    expect(send.mock.calls[0]?.[0]).toContain(
      "count a leave-by time from here): ул. Профсоюзная, 12, Москва"
    );
    expect(send.mock.calls[0]?.[0]).not.toContain("quiet hours");
    expect(send.mock.calls[0]?.[1].auth).toMatchObject({
      attributes: {
        conversationChannel: "telegram",
        scheduledRunKind: "proactive",
        scheduledRunLeaseToken: claim.run.leaseToken,
        scheduledRunId: claim.run.id,
        workspaceId: "workspace:alice",
      },
      authenticator: "scheduled-worker",
      principalId: "better-auth:alice",
    });
    expect(jobs.setSession).toHaveBeenCalledExactlyOnceWith(
      claim.run.id,
      claim.run.leaseToken,
      "worker-session"
    );
  });
});

async function runSchedule(to: ScheduleToFn) {
  let task: Promise<unknown> | undefined;
  const args: ScheduleHandlerArgs = {
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession: vi.fn<ScheduleHandlerArgs["attachSession"]>(),
    to,
    waitUntil(backgroundTask) {
      task = backgroundTask;
    },
  };
  proactiveSchedule.run(args);
  await task;
}

function watch(): Awaited<ReturnType<typeof claimDueProactiveWatches>>[number] {
  return {
    createdByUserId: "better-auth:alice",
    googleState: "connected",
    jobId: "00000000-0000-4000-8000-000000000001",
    leaseUntil: new Date("2026-09-23T12:15:00.000Z"),
    mailCheckedAt: new Date("2026-09-23T11:45:00.000Z"),
    timezone: "Europe/Moscow",
    workspaceId: "workspace:alice",
  };
}

function proactiveClaim(): Awaited<
  ReturnType<typeof claimReadyScheduledAgentRuns>
>[number] {
  return {
    job: {
      conversationChannel: "telegram",
      conversationId: "100::",
      createdAt: afternoon,
      createdByUserId: "better-auth:alice",
      id: "00000000-0000-4000-8000-000000000001",
      kind: "proactive",
      lastError: null,
      lastRunAt: afternoon,
      missedRunPolicy: "skip",
      nextRunAt: null,
      prompt: "Проверить почту и календарь.",
      replyAnchorMessageId: null,
      revision: 0,
      status: "active",
      timing: {
        anchoredAt: afternoon.toISOString(),
        everyMinutes: 15,
        kind: "interval",
      },
      updatedAt: afternoon,
      workspaceId: "workspace:alice",
    },
    run: {
      attempts: 1,
      completedAt: null,
      createdAt: afternoon,
      deferredCompletionTurnId: null,
      id: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000001",
      lastError: null,
      leaseExpiresAt: new Date("2026-09-23T12:05:00.000Z"),
      leaseToken: "00000000-0000-4000-8000-000000000003",
      outcome: null,
      inputResponses: null,
      pendingInputRequests: null,
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportSequence: 0,
      reportStatus: "not_ready",
      retryAt: null,
      scheduledFor: afternoon,
      startedAt: null,
      status: "running",
      updatedAt: afternoon,
      workerSessionId: null,
    },
  };
}

function workerSession(): Session {
  return {
    cancel: vi.fn<Session["cancel"]>(),
    clear: vi.fn<Session["clear"]>(),
    compact: vi.fn<Session["compact"]>(),
    getEventStream: vi.fn<Session["getEventStream"]>(),
    getStreamTailIndex: vi.fn<Session["getStreamTailIndex"]>(),
    id: "worker-session",
    reset: vi.fn<Session["reset"]>(),
    respond: vi.fn<Session["respond"]>(),
    send: vi.fn<Session["send"]>(),
  };
}

/** DP 405 tomorrow at 07:05 Moscow, as the calendar read gives it. */
const dp405 = {
  eventId: "dp405",
  location: "Аэропорт Внуково (VKO), терминал A",
  start: "2026-09-24T07:05:00+03:00",
  summary: "Рейс DP 405 Москва (Внуково) — Сочи",
  timeZone: "Europe/Moscow",
};

const mailSignal = {
  dedupeKey: "m1",
  itemId: "m1",
  source: "gmail" as const,
  threadId: "t1",
};

const checkinSignal = {
  dedupeKey: "dp405@2026-09-24T07:05:00+03:00#checkin",
  itemId: "dp405",
  source: "calendar" as const,
  threadId: null,
};

/** DP 405's watch, nothing handed over yet. */
function flightWatchRow(): Awaited<
  ReturnType<typeof listLiveFlightWatches>
>[number] {
  return {
    action: "worker",
    checkEverySeconds: 3600,
    checks: 0,
    condition: { kind: "reminders" },
    createdAt: afternoon,
    createdByUserId: "better-auth:alice",
    dedupeKey: "dp405@2026-09-24T07:05:00+03:00",
    expiresAt: new Date("2026-09-24T04:05:00.000Z"),
    failures: 0,
    hits: 0,
    id: "watch-1",
    jobId: "flight-job",
    lastCheckedAt: null,
    lastError: null,
    lastHitAt: null,
    nextCheckAt: new Date("9999-12-31T00:00:00.000Z"),
    source: dp405,
    state: { done: [] },
    status: "active",
    template: "flight",
    updatedAt: afternoon,
    wake: "urgent_at_night",
    workspaceId: "workspace:alice",
  };
}
