import type { ScheduleHandlerArgs } from "eve/schedules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { readPricePage } from "@agent/lib/subscriptions/page";
import type { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import type * as flightModule from "@agent/lib/subscriptions/flight";
import type {
  filterUnseenProactiveSignals,
  queueProactiveRun,
} from "@db/services/proactive";
import type {
  readProactiveMessages,
  readUserProfile,
} from "@db/services/user-profile";
import { emptyUserProfile } from "@shared/user-profile/schema";
import type { schedulesEnabled } from "@agent/lib/schedules/enabled";
import type {
  ClaimedSubscription,
  claimDueSubscriptions,
  settleFlightWatch,
  settleSubscriptionCheck,
} from "@db/services/subscriptions";

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof claimDueSubscriptions>(),
  enabled: vi.fn<typeof schedulesEnabled>(() => true),
  page: vi.fn<typeof readPricePage>(),
  pilot: vi.fn<typeof subscriptionsPilot>(() => Promise.resolve(true)),
  settle: vi.fn<typeof settleSubscriptionCheck>(),
  settleFlight: vi.fn<typeof settleFlightWatch>(),
}));
const proactive = vi.hoisted(() => ({
  drive: vi.fn<typeof flightModule.measureDrive>(),
  enabled: vi.fn<typeof readProactiveMessages>(() => Promise.resolve(true)),
  profile: vi.fn<typeof readUserProfile>(),
  queue: vi.fn<typeof queueProactiveRun>(),
  unseen: vi.fn<typeof filterUnseenProactiveSignals>(),
}));
vi.mock("@agent/lib/subscriptions/flight", async (importOriginal) => ({
  ...(await importOriginal<typeof flightModule>()),
  measureDrive: proactive.drive,
}));
vi.mock("@db/services/proactive", () => ({
  filterUnseenProactiveSignals: proactive.unseen,
  queueProactiveRun: proactive.queue,
}));
vi.mock("@db/services/user-profile", () => ({
  readProactiveMessages: proactive.enabled,
  readUserProfile: proactive.profile,
}));
vi.mock("@agent/lib/schedules/enabled", () => ({
  schedulesEnabled: services.enabled,
}));
vi.mock("@agent/lib/subscriptions/page", () => ({
  readPricePage: services.page,
}));
vi.mock("@agent/lib/subscriptions/pilot", () => ({
  subscriptionsPilot: services.pilot,
}));
vi.mock("@db/services/subscriptions", () => ({
  claimDueSubscriptions: services.claim,
  settleFlightWatch: services.settleFlight,
  settleSubscriptionCheck: services.settle,
}));

import subscriptionsSchedule from "@agent/schedules/subscriptions";

afterEach(() => {
  vi.clearAllMocks();
});

function watch(
  id: string,
  url: string,
  overrides: Partial<ClaimedSubscription> = {}
): ClaimedSubscription {
  const created = new Date("2026-10-02T10:00:00.000Z");
  return {
    action: "notify",
    checkEverySeconds: 6 * 60 * 60,
    checks: 0,
    condition: { amount: 8_000, kind: "below" },
    createdAt: created,
    createdByUserId: "alice",
    dedupeKey: url,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    failures: 0,
    hits: 0,
    id,
    jobId: `job-${id}`,
    lastCheckedAt: null,
    lastError: null,
    lastHitAt: null,
    leaseUntil: new Date("2026-10-02T16:10:00.000Z"),
    nextCheckAt: new Date("2026-10-02T16:10:00.000Z"),
    source: {
      currency: "RUB",
      extractor: "jsonld",
      landedOn: url.replace("https://", ""),
      name: "Чайник",
      sku: null,
      url,
    },
    state: { baseline: 8_990, last: 8_990, lastSeenAt: created.toISOString() },
    status: "active",
    template: "price",
    updatedAt: created,
    wake: "day_only",
    workspaceId: "workspace:alice",
    ...overrides,
  };
}

async function runSchedule() {
  let task: Promise<unknown> | undefined;
  subscriptionsSchedule.run({
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession: vi.fn<ScheduleHandlerArgs["attachSession"]>(),
    to: vi.fn<ScheduleHandlerArgs["to"]>(),
    waitUntil(backgroundTask) {
      task = backgroundTask;
    },
  });
  await task;
}

describe("the subscription checks", () => {
  it("reads each due page by code and writes what it found", async () => {
    services.claim.mockResolvedValue([
      watch("w1", "https://shop.example/p/1"),
      watch("w2", "https://shop.example/p/2"),
    ]);
    services.page
      .mockResolvedValueOnce({
        amount: 8_490,
        currency: "RUB",
        extractor: "jsonld",
        kind: "price",
        landedOn: "shop.example/p/1",
        name: "Чайник",
        sku: null,
      })
      .mockResolvedValueOnce({ kind: "blocked", reason: "http 403" });
    services.settle.mockResolvedValue("quiet");
    await runSchedule();

    expect(services.settle).toHaveBeenCalledTimes(2);
    expect(services.settle.mock.calls.map(([, check]) => check.kind)).toEqual([
      "quiet",
      "failed",
    ]);
  });

  it("reads no page for a watch whose term ran out", async () => {
    services.claim.mockResolvedValue([
      watch("w1", "https://shop.example/p/1", {
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ]);
    services.settle.mockResolvedValue("expired");
    await runSchedule();
    expect(services.page).not.toHaveBeenCalled();
    expect(services.settle.mock.calls[0]?.[1].kind).toBe("expired");
  });

  it("keeps going past one watch that throws", async () => {
    services.claim.mockResolvedValue([
      watch("w1", "https://a.example/p/1"),
      watch("w2", "https://b.example/p/2"),
    ]);
    services.page
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ kind: "no-price" });
    services.settle.mockResolvedValue("failed");
    await runSchedule();
    expect(services.settle).toHaveBeenCalledTimes(2);
  });

  it("counts a read that threw as a failed check", async () => {
    services.claim.mockResolvedValue([watch("w1", "https://a.example/p/1")]);
    services.page.mockRejectedValueOnce(new TypeError("decode failed"));
    services.settle.mockResolvedValue("failed");
    await runSchedule();
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      error: "unreachable: TypeError",
      kind: "failed",
    });
  });

  it("holds a watch outside the pilot: no page, no news, a quiet end", async () => {
    services.pilot.mockResolvedValue(false);
    services.claim.mockResolvedValue([
      watch("w1", "https://shop.example/p/1"),
      watch("w2", "https://shop.example/p/2", {
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ]);
    services.settle.mockResolvedValue("held");
    const before = Date.now();
    await runSchedule();
    expect(services.page).not.toHaveBeenCalled();
    expect(services.pilot).toHaveBeenCalledWith({
      userId: "alice",
      workspaceId: "workspace:alice",
    });
    const [held, lapsed] = services.settle.mock.calls.map(([, check]) => check);
    expect(lapsed).toEqual({ kind: "lapsed" });
    expect(held?.kind).toBe("held");
    // Back in the pilot, it goes on a period later.
    const next = held?.kind === "held" ? held.nextCheckAt.getTime() : 0;
    expect(next - before).toBeGreaterThanOrEqual(6 * 60 * 60_000);
    services.pilot.mockResolvedValue(true);
  });

  it("does nothing where schedules are off", async () => {
    services.enabled.mockReturnValueOnce(false);
    await runSchedule();
    expect(services.claim).not.toHaveBeenCalled();
  });
});

/** DP 405 at 07:05 Moscow on 4 October, watched since the day before. */
function flightWatch(
  overrides: Partial<ClaimedSubscription> = {}
): ClaimedSubscription {
  return watch("f1", "https://unused.example", {
    action: "worker",
    condition: { kind: "reminders" },
    dedupeKey: "dp405@2026-10-04T07:05:00+03:00",
    expiresAt: new Date("2026-10-04T04:05:00.000Z"),
    jobId: "proactive-job",
    source: {
      eventId: "dp405",
      location: "Аэропорт Внуково (VKO), терминал A",
      start: "2026-10-04T07:05:00+03:00",
      summary: "Рейс DP 405 Москва (Внуково) — Сочи",
    },
    state: { done: [] },
    template: "flight",
    wake: "urgent_at_night",
    ...overrides,
  });
}

describe("a flight's watch", () => {
  beforeEach(() => {
    // 19:00 in Moscow the evening before: check-in and tonight's reminder.
    vi.useFakeTimers({
      now: new Date("2026-10-03T16:00:00.000Z"),
      toFake: ["Date"],
    });
    proactive.profile.mockResolvedValue({
      ...emptyUserProfile,
      addressLine1: "ул. Профсоюзная, 12",
      city: "Москва",
      timezone: "Europe/Moscow",
    });
    proactive.enabled.mockResolvedValue(true);
    proactive.drive.mockResolvedValue({
      from: "home",
      km: 31.4,
      minutes: 42,
      to: "Внуково",
    });
    proactive.unseen.mockImplementation((_workspace, candidates) =>
      Promise.resolve([...candidates])
    );
    proactive.queue.mockResolvedValue({ runId: "run-1", status: "queued" });
    services.settleFlight.mockResolvedValue("waiting");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the reminders due to one proactive run, with the drive measured once", async () => {
    services.claim.mockResolvedValue([flightWatch()]);
    services.settleFlight.mockResolvedValue("fired");
    await runSchedule();

    expect(proactive.queue).toHaveBeenCalledExactlyOnceWith({
      jobId: "proactive-job",
      maxRunsPerDay: 12,
      now: new Date("2026-10-03T16:00:00.000Z"),
      // The proactive check's own keys, so a reminder it handed over
      // before the pilot is not handed over again.
      signals: [
        {
          dedupeKey: "dp405@2026-10-04T07:05:00+03:00#evening",
          itemId: "dp405",
          source: "calendar",
          threadId: null,
        },
        {
          dedupeKey: "dp405@2026-10-04T07:05:00+03:00#checkin",
          itemId: "dp405",
          source: "calendar",
          threadId: null,
        },
      ],
      workspaceId: "workspace:alice",
    });
    expect(proactive.drive).toHaveBeenCalledOnce();
    // Nothing is left ahead: the watch has done its job.
    expect(services.settleFlight).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "f1" }),
      {
        kind: "ended",
        state: {
          done: ["evening", "checkin"],
          travel: { from: "home", km: 31.4, minutes: 42, to: "Внуково" },
        },
        status: "fired",
      }
    );
    expect(services.page).not.toHaveBeenCalled();
  });

  it("waits for the next reminder's window, reading nothing", async () => {
    // 09:00 the day before: check-in done, the evening still ahead.
    vi.setSystemTime(new Date("2026-10-03T06:00:00.000Z"));
    services.claim.mockResolvedValue([
      flightWatch({ state: { done: ["checkin"], travel: null } }),
    ]);
    await runSchedule();
    expect(proactive.queue).not.toHaveBeenCalled();
    expect(proactive.drive).not.toHaveBeenCalled();
    expect(services.settleFlight).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "f1" }),
      {
        kind: "next",
        nextCheckAt: new Date("2026-10-03T15:00:00.000Z"),
        state: { done: ["checkin"], travel: null },
      }
    );
  });

  it("tries again in a few minutes while another proactive run is open", async () => {
    services.claim.mockResolvedValue([flightWatch()]);
    proactive.queue.mockResolvedValue({ status: "busy" });
    await runSchedule();
    expect(services.settleFlight).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "f1" }),
      {
        kind: "next",
        nextCheckAt: new Date("2026-10-03T16:05:00.000Z"),
        // The drive is kept; the reminders are not yet done.
        state: {
          done: [],
          travel: { from: "home", km: 31.4, minutes: 42, to: "Внуково" },
        },
      }
    );
  });

  it("hands nothing over that a run had, or to a person who turned proactive messages off", async () => {
    services.claim.mockResolvedValue([flightWatch()]);
    proactive.unseen.mockResolvedValue([]);
    await runSchedule();
    expect(proactive.queue).not.toHaveBeenCalled();

    proactive.enabled.mockResolvedValue(false);
    await runSchedule();
    expect(proactive.unseen).toHaveBeenCalledOnce();
    expect(proactive.drive).toHaveBeenCalledOnce();
    expect(services.settleFlight).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "ended",
        state: { done: ["evening", "checkin"] },
      })
    );
  });

  it("holds a flight's watch outside the pilot, like any other", async () => {
    services.pilot.mockResolvedValue(false);
    services.claim.mockResolvedValue([flightWatch()]);
    services.settle.mockResolvedValue("held");
    await runSchedule();
    expect(services.settle.mock.calls[0]?.[1].kind).toBe("held");
    expect(proactive.queue).not.toHaveBeenCalled();
    services.pilot.mockResolvedValue(true);
  });

  it("ends a watch whose stored flight no longer reads", async () => {
    services.claim.mockResolvedValue([
      // A price's state where a flight's belongs.
      flightWatch({
        state: { baseline: 1, last: 1, lastSeenAt: "2026-10-03T00:00:00Z" },
      }),
    ]);
    await runSchedule();
    expect(services.settleFlight).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "f1" }),
      { kind: "ended", status: "failed" }
    );
  });
});
