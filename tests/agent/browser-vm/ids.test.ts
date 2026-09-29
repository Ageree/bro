import { describe, expect, it } from "vitest";
import {
  browserVmBrowserId,
  browserVmProfileId,
  browserVmTargetOf,
  browserVmWorkspace,
  isBrowserVmId,
  newBrowserVmRunId,
  newBrowserVmSessionId,
} from "@agent/lib/browser-vm/ids";

// Every real workspace id is `personal:<32 hex>`: it holds a colon itself.
const workspaceId = "personal:0123456789abcdef0123456789abcdef";
// What the worker accepts as an id (`safe_id` in browser-vm/worker/worker.py).
const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

describe("browser VM ids", () => {
  it("name their workspace, whatever colons the workspace id holds", () => {
    const profileId = browserVmProfileId(workspaceId, 3);
    const sessionId = newBrowserVmSessionId(workspaceId);
    const runId = newBrowserVmRunId(workspaceId);
    const browserId = browserVmBrowserId(workspaceId, "9A1F0C3B2E");

    expect(profileId).toBe(`vm:${workspaceId}:p3`);
    expect(sessionId).toMatch(
      /^vm:personal:[\da-f]{32}:s:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u
    );
    expect(runId).toMatch(/^vm:personal:[\da-f]{32}:r:[\da-f-]{36}$/u);
    expect(browserId).toBe(`vm:${workspaceId}:b:9A1F0C3B2E`);
    for (const id of [profileId, sessionId, runId, browserId]) {
      expect(isBrowserVmId(id)).toBe(true);
      expect(browserVmWorkspace(id)).toBe(workspaceId);
    }
  });

  it("are new for every session and run", () => {
    expect(newBrowserVmSessionId(workspaceId)).not.toBe(
      newBrowserVmSessionId(workspaceId)
    );
    expect(newBrowserVmRunId(workspaceId)).not.toBe(
      newBrowserVmRunId(workspaceId)
    );
  });

  // The worker refuses a session or run id it cannot keep on disk.
  it("give the worker session and run ids it accepts", () => {
    expect(newBrowserVmSessionId(workspaceId)).toMatch(workerIdPattern);
    expect(newBrowserVmRunId(workspaceId)).toMatch(workerIdPattern);
  });

  it("are read from the end, so a workspace id that looks like a marker survives", () => {
    const profileId = browserVmProfileId("team:p1", 2);
    const sessionId = newBrowserVmSessionId("team:s:x");

    expect(profileId).toBe("vm:team:p1:p2");
    expect(browserVmWorkspace(profileId)).toBe("team:p1");
    expect(browserVmWorkspace(sessionId)).toBe("team:s:x");
  });

  it("leave Browser Use ids to Browser Use", () => {
    const browserUseId = "11111111-1111-4111-8111-111111111111";

    expect(isBrowserVmId(browserUseId)).toBe(false);
    expect(() => browserVmWorkspace(browserUseId)).toThrow(
      "Not a browser VM id"
    );
    expect(() => browserVmWorkspace("vm:no-marker")).toThrow(
      "Not a browser VM id"
    );
  });

  it("give back the tab a keep-alive browser stands for", () => {
    const browserId = browserVmBrowserId(workspaceId, "9A1F0C3B2E");

    expect(browserVmTargetOf(browserId)).toBe("9A1F0C3B2E");
    expect(() => browserVmTargetOf(newBrowserVmSessionId(workspaceId))).toThrow(
      "Not a browser VM browser id"
    );
  });

  it("refuse parts that would not read back", () => {
    expect(() => browserVmProfileId("", 1)).toThrow(
      "No browser VM id reads back"
    );
    expect(() => browserVmProfileId(workspaceId, -1)).toThrow("whole number");
    expect(() => browserVmBrowserId(workspaceId, "a:b")).toThrow(
      "No browser VM id reads back"
    );
  });
});
