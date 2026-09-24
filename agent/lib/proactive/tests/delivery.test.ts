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

import { holdProactiveReport } from "@agent/lib/proactive/delivery";

const report = {
  runId: "00000000-0000-4000-8000-000000000002",
  scope: { userId: "better-auth:alice", workspaceId: "workspace:alice" },
};

describe("proactive report delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profile.enabled.mockResolvedValue(true);
    profile.timeZone.mockResolvedValue("Europe/Moscow");
  });

  it("lets a daytime report through", async () => {
    expect(
      await holdProactiveReport(report, new Date("2026-09-23T12:00:00.000Z"))
    ).toBe(false);
    expect(reports.defer).not.toHaveBeenCalled();
  });

  it("holds a report that finished at night until the morning", async () => {
    const now = new Date("2026-09-23T21:10:00.000Z");
    expect(await holdProactiveReport(report, now)).toBe(true);
    expect(reports.defer).toHaveBeenCalledExactlyOnceWith(
      report.runId,
      new Date("2026-09-24T05:00:00.000Z"),
      now
    );
  });

  it("drops the report of someone who opted out meanwhile", async () => {
    profile.enabled.mockResolvedValue(false);
    const claim = { job: {}, run: { reportLeaseToken: "lease" } };
    // SAFETY: holdProactiveReport reads only the claimed run's lease token.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial claim stands in for the full row.
    reports.claim.mockResolvedValue(claim as never);

    expect(
      await holdProactiveReport(report, new Date("2026-09-23T12:00:00.000Z"))
    ).toBe(true);
    expect(reports.drop).toHaveBeenCalledExactlyOnceWith(
      report.runId,
      "lease",
      new Date("2026-09-23T12:00:00.000Z")
    );
  });
});
