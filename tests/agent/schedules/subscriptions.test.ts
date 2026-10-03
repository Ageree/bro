import type { ScheduleHandlerArgs } from "eve/schedules";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { readPricePage } from "@agent/lib/subscriptions/page";
import type { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import type { schedulesEnabled } from "@agent/lib/schedules/enabled";
import type {
  ClaimedSubscription,
  claimDueSubscriptions,
  settleSubscriptionCheck,
} from "@db/services/subscriptions";

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof claimDueSubscriptions>(),
  enabled: vi.fn<typeof schedulesEnabled>(() => true),
  page: vi.fn<typeof readPricePage>(),
  pilot: vi.fn<typeof subscriptionsPilot>(() => Promise.resolve(true)),
  settle: vi.fn<typeof settleSubscriptionCheck>(),
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
