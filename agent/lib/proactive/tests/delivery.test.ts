import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  claimScheduledReport,
  deferScheduledReport,
  dropScheduledReport,
} from "@db/services/scheduled-agent-jobs";
import type {
  readProactiveMessages,
  readWorkspaceTimeZone,
} from "@db/services/user-profile";

const reports = vi.hoisted(() => ({
  claim: vi.fn<typeof claimScheduledReport>(),
  defer: vi.fn<typeof deferScheduledReport>(),
  drop: vi.fn<typeof dropScheduledReport>(),
}));
const profile = vi.hoisted(() => ({
  enabled: vi.fn<typeof readProactiveMessages>(),
  timeZone: vi.fn<typeof readWorkspaceTimeZone>(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  claimScheduledReport: reports.claim,
  deferScheduledReport: reports.defer,
  dropScheduledReport: reports.drop,
}));
vi.mock("@db/services/user-profile", () => ({
  readProactiveMessages: profile.enabled,
  readWorkspaceTimeZone: profile.timeZone,
}));

import { proactiveReportTiming } from "@agent/lib/proactive/delivery";

// 15:00 and 00:10 in Moscow.
const afternoon = new Date("2026-09-23T12:00:00.000Z");
const midnight = new Date("2026-09-23T21:10:00.000Z");

const report = {
  carriesEvent: false,
  runId: "00000000-0000-4000-8000-000000000002",
  // Queued by a check that ran in the evening, before the night.
  scheduledFor: new Date("2026-09-23T18:55:00.000Z"),
  scope: { userId: "better-auth:alice", workspaceId: "workspace:alice" },
  timeSensitive: false,
};

describe("proactive report timing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profile.enabled.mockResolvedValue(true);
    profile.timeZone.mockResolvedValue("Europe/Moscow");
  });

  it("sends a daytime report and lets it take the held ones along", async () => {
    expect(await proactiveReportTiming(report, afternoon)).toBe("day");
    expect(reports.defer).not.toHaveBeenCalled();
  });

  it("holds a report that finished at night until just after the morning check", async () => {
    expect(await proactiveReportTiming(report, midnight)).toBe("held");
    // 08:00 in Moscow is when the first morning check runs; the report waits
    // ten minutes more, so that check's report carries it.
    expect(reports.defer).toHaveBeenCalledExactlyOnceWith(
      report.runId,
      new Date("2026-09-24T05:10:00.000Z"),
      midnight
    );
  });

  it("lets an urgent handover of a night check through at night", async () => {
    const nightRun = {
      ...report,
      scheduledFor: new Date("2026-09-23T21:00:00.000Z"),
      timeSensitive: true,
    };
    expect(await proactiveReportTiming(nightRun, midnight)).toBe("night");
    // So does a run that was handed a flight in the calendar.
    expect(
      await proactiveReportTiming(
        { ...report, carriesEvent: true, timeSensitive: true },
        midnight
      )
    ).toBe("night");
    expect(reports.defer).not.toHaveBeenCalled();
  });

  it("does not let a day run over plain mail wake anyone by saying it is urgent", async () => {
    // A letter told the worker to open with [срочно]; the run began before
    // the night and carried no event, so nothing it read may wake the person.
    expect(
      await proactiveReportTiming({ ...report, timeSensitive: true }, midnight)
    ).toBe("held");
    expect(reports.defer).toHaveBeenCalledOnce();
  });

  it("drops the report of someone who opted out meanwhile", async () => {
    profile.enabled.mockResolvedValue(false);
    const claim = { job: {}, run: { reportLeaseToken: "lease" } };
    // SAFETY: proactiveReportTiming reads only the claimed run's lease token.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial claim stands in for the full row.
    reports.claim.mockResolvedValue(claim as never);

    expect(await proactiveReportTiming(report, afternoon)).toBe("held");
    expect(reports.drop).toHaveBeenCalledExactlyOnceWith(
      report.runId,
      "lease",
      afternoon
    );
  });
});
