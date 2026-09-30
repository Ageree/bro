import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as browserVmRecords from "@db/services/browser-vms";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const vmRunId = `vm:${workspaceId}:r:3f1c2b1e-8e4a-4f7b-9d1e-2a6c5b4d3e21`;
const now = new Date("2026-09-30T12:00:00.000Z");
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);

const records = vi.hoisted(() => ({
  clearBrowserVmStopNotBefore:
    vi.fn<typeof browserVmRecords.clearBrowserVmStopNotBefore>(),
  extendBrowserVmStopNotBefore:
    vi.fn<typeof browserVmRecords.extendBrowserVmStopNotBefore>(),
}));

vi.mock("@db/services/browser-vms", () => records);

beforeEach(() => {
  records.clearBrowserVmStopNotBefore.mockResolvedValue();
  records.extendBrowserVmStopNotBefore.mockResolvedValue();
});

afterEach(() => {
  clearBrowserVmSettings();
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadIdle(settings: Record<string, string> = {}) {
  return importWithSettings(
    { ...browserVmTestEnvironment, ...settings },
    async () => import("@agent/lib/browser-vm/idle")
  );
}

describe("how long a browser VM stays up, by who woke it", () => {
  it("puts the VM on the person's window for their own errand", async () => {
    const idle = await loadIdle();

    await idle.keepBrowserVmForErrand(workspaceId, true, now);

    expect(records.clearBrowserVmStopNotBefore).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      now
    );
    expect(records.extendBrowserVmStopNotBefore).not.toHaveBeenCalled();
  });

  it("keeps what is set for an errand nobody waits for, writing down the person's window", async () => {
    const idle = await loadIdle();

    await idle.keepBrowserVmForErrand(workspaceId, false, now);

    expect(records.clearBrowserVmStopNotBefore).not.toHaveBeenCalled();
    expect(
      records.extendBrowserVmStopNotBefore
    ).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      { personIdleMs: 20 * 60_000, until: now },
      now
    );
  });

  it("keeps the VM for the code wait after a run stopped for the person", async () => {
    const idle = await loadIdle();

    await idle.keepBrowserVmForPersonStep(vmRunId, now);

    expect(
      records.extendBrowserVmStopNotBefore
    ).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      { personIdleMs: 20 * 60_000, until: minutes(15) },
      now
    );
  });

  it("stops a VM on a short window a little after the report reached the conversation", async () => {
    const idle = await loadIdle({ BROWSER_VM_IDLE_BACKGROUND_MINUTES: "3" });

    await idle.keepBrowserVmAfterReport(vmRunId, now);

    expect(
      records.extendBrowserVmStopNotBefore
    ).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      { onlyIfSet: true, personIdleMs: 20 * 60_000, until: minutes(3) },
      now
    );
  });

  it("leaves Browser Use runs alone", async () => {
    const idle = await loadIdle();
    const browserUseRun = "11111111-1111-4111-8111-111111111111";

    await idle.keepBrowserVmForPersonStep(browserUseRun, now);
    await idle.keepBrowserVmAfterReport(browserUseRun, now);

    expect(records.extendBrowserVmStopNotBefore).not.toHaveBeenCalled();
  });

  it("never fails the errand over the bookkeeping", async () => {
    const idle = await loadIdle();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    records.clearBrowserVmStopNotBefore.mockRejectedValue(new Error("down"));
    records.extendBrowserVmStopNotBefore.mockRejectedValue(new Error("down"));

    await expect(
      idle.keepBrowserVmForErrand(workspaceId, true, now)
    ).resolves.toBeUndefined();
    await expect(
      idle.keepBrowserVmAfterReport(vmRunId, now)
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    // The person's window: unused for BROWSER_VM_IDLE_MINUTES.
    [null, 20, true],
    [null, 19, false],
    // A short window: past its stop time and the grace after the last use.
    [minutes(-1), 2, true],
    [minutes(-1), 1, false],
    [minutes(1), 30, false],
  ] as const)(
    "decides the stop at %s, unused for %s minutes: %s",
    async (stopNotBefore, unusedMinutes, due) => {
      const idle = await loadIdle();

      expect(
        idle.browserVmIdleStopDue(
          { lastUsedAt: minutes(-unusedMinutes), stopNotBefore },
          now
        )
      ).toBe(due);
    }
  );

  it("counts a VM never used as idle on either window once its stop time passed", async () => {
    const idle = await loadIdle();

    expect(
      idle.browserVmIdleStopDue({ lastUsedAt: null, stopNotBefore: null }, now)
    ).toBe(true);
    expect(
      idle.browserVmIdleStopDue(
        { lastUsedAt: null, stopNotBefore: minutes(1) },
        now
      )
    ).toBe(false);
  });
});
