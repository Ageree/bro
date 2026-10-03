import { afterEach, describe, expect, it, vi } from "vitest";
import type { deferScheduledReport } from "@db/services/scheduled-agent-jobs";
import type { readSubscriptionWake } from "@db/services/subscriptions";
import type { readWorkspaceTimeZone } from "@db/services/user-profile";

const services = vi.hoisted(() => ({
  defer: vi.fn<typeof deferScheduledReport>(),
  timeZone: vi.fn<typeof readWorkspaceTimeZone>(),
  wake: vi.fn<typeof readSubscriptionWake>(),
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  deferScheduledReport: services.defer,
}));
vi.mock("@db/services/subscriptions", () => ({
  readSubscriptionWake: services.wake,
}));
vi.mock("@db/services/user-profile", () => ({
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
    expect(await subscriptionReportDue(report, day)).toBe(true);
    expect(services.defer).not.toHaveBeenCalled();
  });

  it("holds a price found at night for the morning", async () => {
    services.timeZone.mockResolvedValue("Europe/Moscow");
    services.wake.mockResolvedValue("day_only");
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
    services.wake.mockResolvedValue("urgent_at_night");
    expect(
      await subscriptionReportDue({ ...report, timeSensitive: true }, night)
    ).toBe(true);
    expect(await subscriptionReportDue(report, night)).toBe(false);
  });
});
