import { createHash } from "node:crypto";
import type * as timersModule from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as workerModule from "@agent/lib/browser-vm/worker";
import type { browserVms } from "@db/schema/browser-vms";
import type * as browserVmRecords from "@db/services/browser-vms";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

type BrowserVmRow = typeof browserVms.$inferSelect;

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const now = new Date("2026-09-30T12:00:00.000Z");
const code = new TextEncoder().encode('VERSION = "2026-09-30.1"\n');
const sha256 = createHash("sha256").update(code).digest("hex");
const published = `2026-09-30.1:workers/worker-2026-09-30.1.py:${sha256}`;
const settings = {
  ...browserVmTestEnvironment,
  BROWSER_STATE_BUCKET: "bro-state-test",
  BROWSER_VM_WORKER: published,
  CLOUDRU_S3_TENANT_ID: "test-tenant",
};

const records = vi.hoisted(() => ({
  listOpenBrowserVmRuns: vi.fn<typeof browserVmRecords.listOpenBrowserVmRuns>(),
  updateBrowserVm: vi.fn<typeof browserVmRecords.updateBrowserVm>(),
}));
const listWorkspacesHoldingBrowsers = vi.hoisted(() =>
  vi.fn<(workspaceIds: readonly string[], now?: Date) => Promise<string[]>>()
);
const worker = vi.hoisted(() => ({
  readBrowserVmWorkerHealth:
    vi.fn<typeof workerModule.readBrowserVmWorkerHealth>(),
  updateBrowserVmWorkerCode:
    vi.fn<typeof workerModule.updateBrowserVmWorkerCode>(),
}));
const alertOwner = vi.hoisted(() =>
  vi.fn<
    (
      key: string,
      text: string,
      options: { readonly repeatAfterMs: number }
    ) => Promise<boolean>
  >()
);
const sleep = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());
/** Object Storage: what a presigned GET of the worker's key answers. */
const objectStorage = vi.hoisted(() =>
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
);

vi.mock("@db/services/browser-vms", () => records);
vi.mock("@db/services/browser-runs", () => ({
  listWorkspacesHoldingBrowsers,
}));
vi.mock("@agent/lib/browser-vm/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof workerModule>()),
  ...worker,
}));
vi.mock("@agent/lib/owner-alert", () => ({ alertOwner }));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof timersModule>()),
  setTimeout: sleep,
}));

function vmRow(overrides: Partial<BrowserVmRow> = {}) {
  return {
    bootDiskId: "disk-1",
    claimedAt: now,
    createdAt: now,
    floatingIpId: "fip-1",
    generation: 1,
    givenUpAt: null,
    healthFailures: 0,
    host: "45.132.176.116",
    hostId: null,
    image: "bro-browser-test-1",
    lastError: null,
    lastUsedAt: now,
    leaseUntil: new Date(now.getTime() + 120_000),
    parkFailures: 0,
    parkRetryAt: null,
    poweredOnAt: null,
    profileGeneration: 1,
    profileResetPending: false,
    proxyExit: null,
    proxySession: null,
    recoveries: 0,
    sandboxState: null,
    snapshotChunks: null,
    snapshotFormat: null,
    snapshotGeneration: null,
    snapshotKey: null,
    state: "ready",
    stateChangedAt: now,
    stopNotBefore: null,
    updatedAt: now,
    vmId: "vm-1",
    vmName: "bro-personal0123456789ab-1",
    workerFailedVersion: null,
    workspaceId,
    ...overrides,
  } satisfies BrowserVmRow;
}

function health(version = "2026-09-29.1", busy = false) {
  return {
    busy,
    chrome: true,
    configured: true,
    generation: 1,
    image: "bro-browser-test-1",
    proxy: true,
    stage: null,
    uptimeSeconds: 120,
    worker: version,
  };
}

function openRun(createdAt: Date) {
  return {
    createdAt,
    error: null,
    finalUrl: null,
    finishedAt: null,
    id: `vm:${workspaceId}:r:1`,
    result: null,
    sessionId: `vm:${workspaceId}:s:1`,
    status: "running" as const,
    task: "Find the parcel",
    unreadMessages: null,
    updatedAt: now,
    workspaceId,
  };
}

async function loadRollout(overrides: Record<string, string> = {}) {
  return importWithSettings(
    { ...settings, ...overrides },
    async () => import("@agent/lib/browser-vm/rollout")
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", objectStorage);
  objectStorage.mockImplementation(async () => new Response(code));
  records.listOpenBrowserVmRuns.mockResolvedValue([]);
  records.updateBrowserVm.mockImplementation(async (_id, patch) => ({
    ...vmRow(),
    ...patch,
  }));
  listWorkspacesHoldingBrowsers.mockResolvedValue([]);
  worker.updateBrowserVmWorkerCode.mockResolvedValue();
  // Restarting once, then up in the new version.
  worker.readBrowserVmWorkerHealth
    .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
    .mockResolvedValue(health("2026-09-30.1"));
  alertOwner.mockResolvedValue(true);
  sleep.mockResolvedValue();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  clearBrowserVmSettings();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
});

describe("rolling a published worker out to a workspace's VM", () => {
  it("does nothing at all without BROWSER_VM_WORKER", async () => {
    const rollout = await loadRollout({ BROWSER_VM_WORKER: "" });

    expect(rollout.browserVmWorkerDue(vmRow(), health())).toBeUndefined();
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
    expect(records.listOpenBrowserVmRuns).not.toHaveBeenCalled();
  });

  it("leaves a worker that already runs the published version", async () => {
    const rollout = await loadRollout();

    expect(
      rollout.browserVmWorkerDue(vmRow(), health("2026-09-30.1"))
    ).toBeUndefined();
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health("2026-09-30.1"), now)
    ).resolves.toBe(false);
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });

  it("fetches the code by a presigned GET, checks it and hands it to an idle worker", async () => {
    const rollout = await loadRollout();
    const vm = vmRow();

    await expect(
      rollout.rollOutBrowserVmWorker(vm, health(), now)
    ).resolves.toBe(true);

    const [url] = objectStorage.mock.calls[0] ?? [];
    expect(url).toMatch(
      /^https:\/\/s3\.cloud\.ru\/bro-state-test\/workers\/worker-2026-09-30\.1\.py\?/u
    );
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("test-tenant%3Atest-key-id");
    expect(worker.updateBrowserVmWorkerCode).toHaveBeenCalledExactlyOnceWith(
      vm,
      code,
      sha256
    );
    // Waited through the restart for the new version.
    expect(worker.readBrowserVmWorkerHealth).toHaveBeenCalledTimes(2);
    expect(records.updateBrowserVm).not.toHaveBeenCalled();
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it("sends nothing to the worker when the file does not match its checksum, and remembers the version", async () => {
    const rollout = await loadRollout();
    objectStorage.mockImplementation(
      async () => new Response("print('tampered')\n")
    );
    const vm = vmRow();

    await expect(
      rollout.rollOutBrowserVmWorker(vm, health(), now)
    ).resolves.toBe(false);

    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
    expect(records.updateBrowserVm).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      { workerFailedVersion: "2026-09-30.1" },
      expect.any(Date),
      vm.leaseUntil
    );
    expect(alertOwner).toHaveBeenCalledOnce();
    const [key, text, options] = alertOwner.mock.calls[0] ?? [];
    expect(key).toBe("browser-vm-worker:2026-09-30.1");
    expect(text).toContain("sha256");
    expect(options?.repeatAfterMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60_000);
  });

  it("waits while a run is open, a page is kept, or the worker is busy", async () => {
    const rollout = await loadRollout();

    records.listOpenBrowserVmRuns.mockResolvedValueOnce([openRun(now)]);
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);

    listWorkspacesHoldingBrowsers.mockResolvedValueOnce([workspaceId]);
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);

    expect(
      rollout.browserVmWorkerDue(vmRow(), health("2026-09-29.1", true))
    ).toBeUndefined();

    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it("does not wait on a run record nobody read to its end for an hour", async () => {
    const rollout = await loadRollout();
    records.listOpenBrowserVmRuns.mockResolvedValue([
      openRun(new Date(now.getTime() - 2 * 60 * 60_000)),
    ]);

    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(true);
    expect(worker.updateBrowserVmWorkerCode).toHaveBeenCalledOnce();
  });

  it("does not try a version again on a VM where it failed", async () => {
    const rollout = await loadRollout();
    const vm = vmRow({ workerFailedVersion: "2026-09-30.1" });

    expect(rollout.browserVmWorkerDue(vm, health())).toBeUndefined();
    await expect(
      rollout.rollOutBrowserVmWorker(vm, health(), now)
    ).resolves.toBe(false);
    expect(objectStorage).not.toHaveBeenCalled();
    // A newer publication is tried again.
    expect(
      rollout.browserVmWorkerDue(
        vmRow({ workerFailedVersion: "2026-09-29.9" }),
        health()
      )?.version
    ).toBe("2026-09-30.1");
  });

  it("remembers code the worker refused to load, and code that did not come up", async () => {
    const rollout = await loadRollout();
    const { BrowserVmWorkerError } =
      await import("@agent/lib/browser-vm/worker");
    worker.updateBrowserVmWorkerCode.mockRejectedValueOnce(
      new BrowserVmWorkerError(400, "/v1/admin/worker", "ImportError: x")
    );

    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    expect(records.updateBrowserVm).toHaveBeenLastCalledWith(
      workspaceId,
      { workerFailedVersion: "2026-09-30.1" },
      expect.any(Date),
      expect.any(Date)
    );

    // Taken, but the health check keeps answering the old version (rolled
    // back) until the wait is over.
    worker.readBrowserVmWorkerHealth.mockReset();
    worker.readBrowserVmWorkerHealth.mockResolvedValue(health());
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(true);
    expect(
      worker.readBrowserVmWorkerHealth.mock.calls.length
    ).toBeLessThanOrEqual(15);
    expect(records.updateBrowserVm).toHaveBeenCalledTimes(2);
    expect(alertOwner).toHaveBeenCalledTimes(2);
    expect(
      alertOwner.mock.calls.every(
        ([key]) => key === "browser-vm-worker:2026-09-30.1"
      )
    ).toBe(true);
  });

  it("tries again later when Object Storage or the worker were only out of reach", async () => {
    const rollout = await loadRollout();
    const { BrowserVmWorkerError } =
      await import("@agent/lib/browser-vm/worker");
    objectStorage.mockRejectedValueOnce(new Error("timeout"));

    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
    expect(alertOwner).toHaveBeenCalledOnce();

    // A run started between the checks: the worker says busy.
    worker.updateBrowserVmWorkerCode.mockRejectedValueOnce(
      new BrowserVmWorkerError(409, "/v1/admin/worker", '{"error":"busy"}')
    );
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);

    expect(records.updateBrowserVm).not.toHaveBeenCalled();
    expect(alertOwner).toHaveBeenCalledOnce();
  });

  it("leaves a sandbox of the pool alone", async () => {
    const rollout = await loadRollout();
    const sandbox = vmRow({ hostId: "bro-host-1", sandboxState: "running" });

    expect(rollout.browserVmWorkerDue(sandbox, health())).toBeUndefined();
    await expect(
      rollout.rollOutBrowserVmWorker(sandbox, health(), now)
    ).resolves.toBe(false);
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });
});
