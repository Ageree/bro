import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as browserUseClient from "@agent/lib/browser-use/client";
import { BrowserUseError } from "@agent/lib/browser-use/client";
import { clearBrowserVmSettings } from "../../helpers/browser-vm";

const {
  cancelBrowserUseRun,
  findBrowserRunMakingWay,
  makeWayForPersonErrand,
  listBrowserHoldingRuns,
  moveQueuedBrowserRunsBack,
  readBrowserVmRun,
} = vi.hoisted(() => ({
  cancelBrowserUseRun: vi.fn<(runId: string) => Promise<object>>(),
  findBrowserRunMakingWay:
    vi.fn<
      (
        workspaceId: string,
        profileId: string,
        now?: Date
      ) => Promise<{ readonly id: string } | undefined>
    >(),
  makeWayForPersonErrand:
    vi.fn<
      (
        runId: string,
        queued: { readonly pendingTask: string; readonly retryAt: Date }
      ) => Promise<{ readonly id: string } | undefined>
    >(),
  listBrowserHoldingRuns:
    vi.fn<
      (
        workspaceId: string
      ) => Promise<{ readonly startedByPerson: boolean | null }[]>
    >(),
  moveQueuedBrowserRunsBack:
    vi.fn<(workspaceId: string, marker: string, now?: Date) => Promise<void>>(),
  readBrowserVmRun:
    vi.fn<(runId: string) => Promise<{ readonly task: string } | undefined>>(),
}));

vi.mock("@db/services/browser-runs", () => ({
  findBrowserRunMakingWay,
  listBrowserHoldingRuns,
  makeWayForPersonErrand,
  moveQueuedBrowserRunsBack,
}));
vi.mock("@db/services/browser-vms", () => ({ readBrowserVmRun }));
vi.mock("@agent/lib/browser-use/client", async (importOriginal) => ({
  ...(await importOriginal<typeof browserUseClient>()),
  cancelBrowserUseRun,
}));

/** The module as a workspace in the pilot (`*`) or out of it sees it. */
async function load(pilot?: string) {
  vi.resetModules();
  if (pilot !== undefined) vi.stubEnv("BROWSER_MAKE_WAY_WORKSPACES", pilot);
  return import("@agent/lib/browser-use/make-way");
}

const scope = { userId: "alice", workspaceId: "personal:alice" };
const profileId = "vm:personal:alice";

beforeEach(() => {
  findBrowserRunMakingWay.mockResolvedValue({ id: "vm:run-1" });
  readBrowserVmRun.mockResolvedValue({ task: "Find two more chargers" });
  makeWayForPersonErrand.mockResolvedValue({ id: "queued:copy" });
  cancelBrowserUseRun.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  clearBrowserVmSettings();
});

describe("a person's errand making its way", () => {
  it("takes nothing from a follow-up outside the pilot or off the person's own browser", async () => {
    const outside = await load();
    expect(await outside.makeWayForPerson(scope, profileId)).toBeUndefined();
    const { makeWayForPerson } = await load("*");
    expect(
      await makeWayForPerson(scope, "browser-use-profile")
    ).toBeUndefined();
    expect(findBrowserRunMakingWay).not.toHaveBeenCalled();
    expect(cancelBrowserUseRun).not.toHaveBeenCalled();
  });

  it("closes the follow-up before stopping it, and queues it to carry on", async () => {
    const { madeWayTask, makeWayForPerson } = await load("*");
    const now = new Date("2026-10-25T12:00:00.000Z");

    expect(await makeWayForPerson(scope, profileId, now)).toBe("queued:copy");
    expect(makeWayForPersonErrand).toHaveBeenCalledWith("vm:run-1", {
      pendingTask: madeWayTask("Find two more chargers"),
      retryAt: new Date(now.getTime() + 5 * 60_000),
    });
    // Closed first: the run's end must not reach the person as «stopped».
    expect(makeWayForPersonErrand.mock.invocationCallOrder[0]).toBeLessThan(
      cancelBrowserUseRun.mock.invocationCallOrder[0] ?? 0
    );
    expect(cancelBrowserUseRun).toHaveBeenCalledWith("vm:run-1");
  });

  it("stops nothing that settled or was taken over meanwhile", async () => {
    const { makeWayForPerson } = await load("*");
    makeWayForPersonErrand.mockResolvedValueOnce(undefined);
    expect(await makeWayForPerson(scope, profileId)).toBeUndefined();
    findBrowserRunMakingWay.mockResolvedValueOnce(undefined);
    expect(await makeWayForPerson(scope, profileId)).toBeUndefined();
    // A database that does not answer stops nothing either.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    findBrowserRunMakingWay.mockRejectedValueOnce(new Error("db down"));
    expect(await makeWayForPerson(scope, profileId)).toBeUndefined();
    expect(cancelBrowserUseRun).not.toHaveBeenCalled();
  });

  it("keeps the queued copy when the stop does not go through", async () => {
    const { makeWayForPerson } = await load("*");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    cancelBrowserUseRun.mockRejectedValueOnce(new Error("worker gone"));
    expect(await makeWayForPerson(scope, profileId)).toBe("queued:copy");
  });

  it("starts again with the errand's own instruction and one pause note", async () => {
    const { madeWay, madeWayTask } = await load();
    const { siteOperationsLead } =
      await import("@agent/lib/browser-vm/site-ops/run");
    // A start puts the queue's bookkeeping after the errand, then the site's
    // known operations and the wall rule: each start adds them anew.
    const once = madeWayTask(
      [
        "Find two more chargers",
        "(Queued errand queued:a; for bookkeeping only.)",
        `${siteOperationsLead} op("wb", url) for a results page like …`,
      ].join("\n\n")
    );
    const twice = madeWayTask(
      [once, "(Queued errand queued:b; for bookkeeping only.)"].join("\n\n")
    );
    expect(twice).toBe(once);
    expect(
      once.startsWith("Find two more chargers\n\n[Carried on after a pause]")
    ).toBe(true);
    expect(once).not.toContain("Queued errand");
    expect(once).not.toContain(siteOperationsLead);
    expect(madeWay({ pendingTask: once })).toBe(true);
    expect(madeWay({ pendingTask: "Find two more chargers" })).toBe(false);
  });

  it("keeps a run that made way off the browser while a page waits for the person", async () => {
    const { madeWayTask, madeWayWaits } = await load();
    const copy = {
      pendingTask: madeWayTask("Find two more chargers"),
      workspaceId: scope.workspaceId,
    };
    listBrowserHoldingRuns.mockResolvedValueOnce([{ startedByPerson: true }]);
    expect(await madeWayWaits(copy)).toBe(true);
    listBrowserHoldingRuns.mockResolvedValueOnce([{ startedByPerson: false }]);
    expect(await madeWayWaits(copy)).toBe(false);
    // Any other queued errand starts as before, without a look.
    expect(
      await madeWayWaits({ pendingTask: "Find a kettle", workspaceId: "w" })
    ).toBe(false);
    expect(listBrowserHoldingRuns).toHaveBeenCalledTimes(2);
  });

  it("puts every run that made way behind a person's queued errand, in the pilot only", async () => {
    const outside = await load();
    await outside.waitBehindPerson(scope);
    expect(moveQueuedBrowserRunsBack).not.toHaveBeenCalled();
    const { waitBehindPerson } = await load("*");
    await waitBehindPerson(scope);
    expect(moveQueuedBrowserRunsBack).toHaveBeenCalledWith(
      scope.workspaceId,
      "\n\n[Carried on after a pause] ",
      expect.any(Date)
    );
  });

  it("tries the start again while the stopped run lets the browser go, then gives the busy answer back", async () => {
    const { startOnceFreed } = await load();
    vi.useFakeTimers();
    const busy = new BrowserUseError(429, "browser-vm", "busy", 60_000);
    const onBusy = vi.fn<() => void>();
    const freed = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce("run");
    const started = startOnceFreed(freed, onBusy);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await started).toBe("run");
    expect(onBusy).toHaveBeenCalledTimes(1);

    const stillBusy = vi.fn<() => Promise<string>>().mockRejectedValue(busy);
    const given = startOnceFreed(stillBusy, onBusy);
    // Its refusal is awaited below, once the pauses have run.
    given.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(given).rejects.toBe(busy);
    expect(stillBusy).toHaveBeenCalledTimes(4);
  });
});
