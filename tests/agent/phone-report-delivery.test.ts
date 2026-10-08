import type { AttachSessionFn } from "eve/channels";
import type { ScheduleToFn } from "eve/schedules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PhoneService from "@db/services/phone";

type ReportRow = Pick<
  Awaited<ReturnType<typeof PhoneService.claimPhoneReports>>[number],
  | "carrierRub"
  | "conversationChannel"
  | "conversationId"
  | "costUsd"
  | "direction"
  | "durationSeconds"
  | "id"
  | "outcome"
  | "ownerUserId"
  | "reportLeaseToken"
  | "sessionId"
  | "state"
  | "summary"
  | "target"
  | "taskSucceeded"
  | "workspaceId"
>;

const claimPhoneReports = vi.hoisted(() =>
  vi.fn<() => Promise<ReportRow[]>>(() => Promise.resolve([]))
);
const finishPhoneReport = vi.hoisted(() =>
  vi.fn<(id: string, token: string, delivered: boolean) => Promise<boolean>>(
    () => Promise.resolve(false)
  )
);
const holdPhoneReportForTurn = vi.hoisted(() =>
  vi.fn<(id: string, token: string) => Promise<void>>(() => Promise.resolve())
);
vi.mock("@db/services/phone", () => ({
  claimPhoneReports,
  finishPhoneReport,
  holdPhoneReportForTurn,
}));
vi.mock("@agent/channels/photon", () => ({ default: {} }));
vi.mock("@agent/channels/telegram", () => ({ default: {} }));

import { deliverPhoneReports } from "@agent/lib/phone/report";

const callId = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";

function row(): ReportRow {
  return {
    id: callId,
    ownerUserId: "user-1",
    workspaceId: "workspace:user-1",
    sessionId: "session-1",
    conversationId: "session-1",
    conversationChannel: "eve",
    reportLeaseToken: token,
    direction: "outbound",
    target: "+74950000002",
    state: "done",
    outcome: "done",
    taskSucceeded: true,
    durationSeconds: 12,
    costUsd: "0.01",
    carrierRub: "2",
    summary: "ok",
  };
}

function deliver(send: () => Promise<{ status: string }>) {
  // SAFETY: the delivery only calls `send` on the handle.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A bare handle stands in for the session handle.
  const attachSession = vi.fn<AttachSessionFn>(() => ({ send }) as never);
  const to = vi.fn<ScheduleToFn>();
  return deliverPhoneReports({ attachSession, to });
}

describe("handing a phone report to its conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    claimPhoneReports.mockResolvedValue([row()]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the lease for the report's turn once eve accepted it", async () => {
    await deliver(() => Promise.resolve({ status: "accepted" }));

    expect(holdPhoneReportForTurn).toHaveBeenCalledExactlyOnceWith(
      callId,
      token
    );
    expect(finishPhoneReport).not.toHaveBeenCalled();
  });

  it("does not call a dispatch that is still unanswered after 20 seconds a failure", async () => {
    // eve may accept the report after the wait ended; a short backoff
    // would send a second copy beside it.
    const pending = deliver(
      () =>
        new Promise<{ status: string }>(() => {
          // Never answers.
        })
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(holdPhoneReportForTurn).toHaveBeenCalledExactlyOnceWith(
      callId,
      token
    );
    expect(finishPhoneReport).not.toHaveBeenCalled();
  });

  it("backs a refused or failed dispatch off", async () => {
    await deliver(() => Promise.resolve({ status: "rejected" }));
    await deliver(() => Promise.reject(new Error("channel down")));

    expect(finishPhoneReport).toHaveBeenCalledTimes(2);
    expect(finishPhoneReport).toHaveBeenCalledWith(callId, token, false);
    expect(holdPhoneReportForTurn).not.toHaveBeenCalled();
  });
});
