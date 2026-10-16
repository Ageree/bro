import type { ScheduleHandlerArgs } from "eve/schedules";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { readPricePage } from "@agent/lib/subscriptions/page";
import type { readPochtaParcel } from "@agent/lib/subscriptions/parcel/pochta";
import type { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import type { schedulesEnabled } from "@agent/lib/schedules/enabled";
import type {
  ClaimedSubscription,
  claimDueSubscriptions,
  settleSubscriptionCheck,
} from "@db/services/subscriptions";
import type { readProactiveMessages } from "@db/services/user-profile";

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof claimDueSubscriptions>(),
  enabled: vi.fn<typeof schedulesEnabled>(() => true),
  locationPilot: vi.fn<() => boolean>(() => true),
  page: vi.fn<typeof readPricePage>(),
  parcel: vi.fn<typeof readPochtaParcel>(),
  pilot: vi.fn<typeof subscriptionsPilot>(() => Promise.resolve(true)),
  proactiveMessages: vi.fn<typeof readProactiveMessages>(() =>
    Promise.resolve(true)
  ),
  settle: vi.fn<typeof settleSubscriptionCheck>(),
}));
vi.mock("@agent/lib/schedules/enabled", () => ({
  schedulesEnabled: services.enabled,
}));
vi.mock("@agent/lib/subscriptions/page", () => ({
  readPricePage: services.page,
}));
vi.mock("@agent/lib/subscriptions/parcel/pochta", () => ({
  readPochtaParcel: services.parcel,
}));
vi.mock("@agent/lib/subscriptions/pilot", () => ({
  subscriptionsPilot: services.pilot,
}));
vi.mock("@db/services/location", () => ({
  locationPilot: services.locationPilot,
}));
vi.mock("@db/services/subscriptions", () => ({
  claimDueSubscriptions: services.claim,
  settleSubscriptionCheck: services.settle,
}));
vi.mock("@db/services/user-profile", () => ({
  readProactiveMessages: services.proactiveMessages,
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

/** A reminder at a place, as the tick claims it only at its term's end. */
function placeReminder(
  expiresAt: Date,
  sawPosition: boolean
): ClaimedSubscription {
  return watch("p1", "https://unused.example", {
    checkEverySeconds: 86_400,
    condition: { on: "arrive", repeat: false, text: "забрать посылку" },
    dedupeKey: "arrive:55.751,37.618",
    expiresAt,
    source: {
      address: null,
      label: "дом",
      lat: 55.7512,
      lon: 37.6184,
      origin: "home",
      radiusM: 150,
    },
    state: {
      changedAt: null,
      farAt: null,
      inside: false,
      last: null,
      pending: null,
      recentOut: null,
      sawPosition,
    },
    template: "place",
    wake: "urgent_at_night",
  });
}

describe("parcel watches", () => {
  const created = new Date("2026-10-02T10:00:00.000Z");
  const reading = {
    expectedOn: "2026-10-05",
    kind: "parcel" as const,
    lastEvent: "Прибыло в сортировочный центр",
    lastEventAt: "2026-10-02T09:00:00.000Z",
    place: "140983, Москва",
    status: "in_transit" as const,
    storageEnding: false,
    storageUntil: null,
    title: null,
  };
  function parcelWatch(origin: "mail" | "person") {
    return watch("parcel-1", "https://unused.example", {
      checkEverySeconds: 3 * 60 * 60,
      condition: { kind: "changes" },
      dedupeKey: "10100012345678",
      source: {
        carrier: "pochta",
        number: "10100012345678",
        origin,
        title: null,
      },
      state: {
        expectedOn: reading.expectedOn,
        lastEvent: reading.lastEvent,
        lastEventAt: reading.lastEventAt,
        lastSeenAt: created.toISOString(),
        letterPending: false,
        place: reading.place,
        seen: true,
        status: "in_transit",
        storageUntil: null,
        storageWarned: null,
      },
      template: "parcel",
    });
  }

  it("read their carrier, not a page, and stay quiet when nothing changed", async () => {
    services.claim.mockResolvedValue([parcelWatch("person")]);
    services.parcel.mockResolvedValue(reading);
    services.settle.mockResolvedValue("quiet");
    await runSchedule();
    expect(services.parcel).toHaveBeenCalledWith("10100012345678");
    expect(services.page).not.toHaveBeenCalled();
    expect(services.settle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "parcel-1" }),
      expect.objectContaining({ kind: "quiet" })
    );
  });

  it("hold a letter's watch, unread, while the person has Bro's own messages off", async () => {
    services.proactiveMessages.mockResolvedValueOnce(false);
    services.claim.mockResolvedValue([parcelWatch("mail")]);
    services.settle.mockResolvedValue("held");
    await runSchedule();
    expect(services.parcel).not.toHaveBeenCalled();
    expect(services.settle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "parcel-1" }),
      expect.objectContaining({ kind: "held" })
    );
    // The person's own number is theirs to hear of.
    services.claim.mockResolvedValue([parcelWatch("person")]);
    services.parcel.mockResolvedValue(reading);
    services.settle.mockResolvedValue("quiet");
    await runSchedule();
    expect(services.parcel).toHaveBeenCalledOnce();
  });
});

describe("reminders at places", () => {
  it("wait for their term again when it is still ahead", async () => {
    const expiresAt = new Date("2099-01-01T00:00:00.000Z");
    services.claim.mockResolvedValue([placeReminder(expiresAt, true)]);
    services.settle.mockResolvedValue("held");
    await runSchedule();
    expect(services.settle.mock.calls[0]?.[1]).toEqual({
      kind: "held",
      nextCheckAt: expiresAt,
    });
    expect(services.page).not.toHaveBeenCalled();
  });

  it("tell an unused end only after Bro saw where the person was", async () => {
    const ended = new Date("2026-10-01T00:00:00.000Z");
    services.claim.mockResolvedValue([placeReminder(ended, true)]);
    services.settle.mockResolvedValue("expired");
    await runSchedule();
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      kind: "expired",
      outcome: { kind: "result", urgency: "normal" },
    });
    services.settle.mockClear();
    services.claim.mockResolvedValue([placeReminder(ended, false)]);
    await runSchedule();
    expect(services.settle.mock.calls[0]?.[1]).toEqual({ kind: "lapsed" });
    services.settle.mockClear();
    services.locationPilot.mockReturnValueOnce(false);
    services.claim.mockResolvedValue([placeReminder(ended, true)]);
    await runSchedule();
    expect(services.settle.mock.calls[0]?.[1]).toEqual({ kind: "lapsed" });
  });
});

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
      .mockRejectedValueOnce(new TypeError("decode failed"))
      .mockResolvedValueOnce({ kind: "no-price" });
    services.settle.mockResolvedValue("failed");
    await runSchedule();
    expect(services.settle).toHaveBeenCalledTimes(2);
    // A read that threw counts as a failed check.
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
