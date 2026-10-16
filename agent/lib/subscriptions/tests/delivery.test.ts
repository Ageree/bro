import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  claimScheduledReport,
  deferScheduledReport,
  dropScheduledReport,
} from "@db/services/scheduled-agent-jobs";
import type { readSubscriptionDelivery } from "@db/services/subscriptions";
import type {
  readProactiveMessages,
  readWorkspaceTimeZone,
} from "@db/services/user-profile";

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof claimScheduledReport>(),
  defer: vi.fn<typeof deferScheduledReport>(),
  drop: vi.fn<typeof dropScheduledReport>(),
  enabled: vi.fn<typeof readProactiveMessages>(),
  timeZone: vi.fn<typeof readWorkspaceTimeZone>(),
  watch: vi.fn<typeof readSubscriptionDelivery>(),
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  claimScheduledReport: services.claim,
  deferScheduledReport: services.defer,
  dropScheduledReport: services.drop,
}));
vi.mock("@db/services/subscriptions", () => ({
  readSubscriptionDelivery: services.watch,
}));
vi.mock("@db/services/user-profile", () => ({
  readProactiveMessages: services.enabled,
  readWorkspaceTimeZone: services.timeZone,
}));

import { subscriptionReportDue } from "@agent/lib/subscriptions/delivery";

afterEach(() => {
  vi.clearAllMocks();
});

const report = {
  jobId: "job-1",
  runId: "run-1",
  scope: { userId: "alice", workspaceId: "workspace:alice" },
  timeSensitive: false,
};
// 03:00 and 14:00 in Moscow.
const night = new Date("2026-10-03T00:00:00.000Z");
const day = new Date("2026-10-03T11:00:00.000Z");

describe("when a watch's news may go out", () => {
  it("goes out by day", async () => {
    services.timeZone.mockResolvedValue("Europe/Moscow");
    services.watch.mockResolvedValue({ unasked: false, wake: "day_only" });
    expect(await subscriptionReportDue(report, day)).toBe(true);
    expect(services.defer).not.toHaveBeenCalled();
  });

  it("holds a price found at night for the morning", async () => {
    services.timeZone.mockResolvedValue("Europe/Moscow");
    services.watch.mockResolvedValue({ unasked: false, wake: "day_only" });
    expect(await subscriptionReportDue(report, night)).toBe(false);
    expect(
      await subscriptionReportDue({ ...report, timeSensitive: true }, night)
    ).toBe(false);
    // 08:00 Moscow and ten minutes.
    expect(services.defer).toHaveBeenCalledWith(
      "run-1",
      new Date("2026-10-03T05:10:00.000Z"),
      night
    );
  });

  it("wakes the person only for urgent news of a watch that may", async () => {
    services.timeZone.mockResolvedValue("Europe/Moscow");
    services.watch.mockResolvedValue({
      unasked: false,
      wake: "urgent_at_night",
    });
    expect(
      await subscriptionReportDue({ ...report, timeSensitive: true }, night)
    ).toBe(true);
    expect(await subscriptionReportDue(report, night)).toBe(false);
  });

  it("keeps the person's own watch speaking while Bro's own messages are off", async () => {
    services.timeZone.mockResolvedValue("Europe/Moscow");
    services.enabled.mockResolvedValue(false);
    services.watch.mockResolvedValue({ unasked: false, wake: "day_only" });
    expect(await subscriptionReportDue(report, day)).toBe(true);
    expect(services.drop).not.toHaveBeenCalled();
  });
});
