import { afterEach, describe, expect, it, vi } from "vitest";
import type { queueFollowUpRun } from "@db/services/proactive";

const proactive = vi.hoisted(() => ({
  queueFollowUpRun: vi.fn<typeof queueFollowUpRun>(),
}));

vi.mock("@db/services/proactive", () => proactive);

/** The helper reads the pilot when its modules load. */
async function wakeFor(pilot: string) {
  vi.resetModules();
  vi.stubEnv("AGENCY_WORKSPACES", pilot);
  return (await import("@agent/lib/proactive/follow-up")).wakeAgencyForOutcome;
}

afterEach(() => {
  vi.stubEnv("AGENCY_WORKSPACES", "");
  vi.restoreAllMocks();
  proactive.queueFollowUpRun.mockReset();
});

describe("waking the agentic worker on a finished call or run", () => {
  it("queues the finished item as a follow-up in the pilot, keyed by its id", async () => {
    proactive.queueFollowUpRun.mockResolvedValue({
      runId: "run-1",
      status: "queued",
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const wake = await wakeFor("workspace-1");

    await wake({ id: "call-1", source: "phone", workspaceId: "workspace-1" });
    await wake({ id: "run-9", source: "browser", workspaceId: "workspace-1" });

    const [phone, browser] = proactive.queueFollowUpRun.mock.calls;
    expect(phone?.[0]).toMatchObject({
      maxRunsPerDay: 12,
      signal: {
        dedupeKey: "call-1",
        itemId: "call-1",
        source: "phone",
        threadId: null,
      },
      workspaceId: "workspace-1",
    });
    expect(browser?.[0]?.signal).toMatchObject({
      dedupeKey: "run-9",
      source: "browser",
    });
  });

  it("leaves every workspace outside the pilot as it was", async () => {
    const wake = await wakeFor("workspace-1");
    await wake({ id: "call-1", source: "phone", workspaceId: "workspace-2" });
    expect(proactive.queueFollowUpRun).not.toHaveBeenCalled();
  });

  it("never fails the report it rides on, and logs the failure", async () => {
    proactive.queueFollowUpRun.mockRejectedValue(new Error("db is down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const wake = await wakeFor("workspace-1");

    await expect(
      wake({ id: "call-1", source: "phone", workspaceId: "workspace-1" })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[proactive] follow-up failed",
      expect.objectContaining({ source: "phone", workspaceId: "workspace-1" })
    );
  });
});
