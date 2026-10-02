import { createHash } from "node:crypto";
import type * as timersModule from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as cloudRuModule from "@agent/lib/browser-vm/cloudru";
import type * as workerModule from "@agent/lib/browser-vm/worker";
import type { browserVms } from "@db/schema/browser-vms";
import type * as browserVmRecords from "@db/services/browser-vms";
import type * as usageCostRecords from "@db/services/usage-costs";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

type BrowserVmRow = typeof browserVms.$inferSelect;

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const now = new Date("2026-09-28T12:00:00.000Z");
const host = "45.132.176.116";

/**
 * The `browser_vms` rows as the service would keep them: the lifecycle reads
 * back what it wrote, so a test asserts on where the record ended up.
 */
const rows = vi.hoisted(() => new Map<string, BrowserVmRow>());

const records = vi.hoisted(() => ({
  claimBrowserVmLease: vi.fn<typeof browserVmRecords.claimBrowserVmLease>(),
  clearBrowserVmProfileReset:
    vi.fn<typeof browserVmRecords.clearBrowserVmProfileReset>(),
  deleteBrowserVmRecord: vi.fn<typeof browserVmRecords.deleteBrowserVmRecord>(),
  ensureBrowserVmRecord: vi.fn<typeof browserVmRecords.ensureBrowserVmRecord>(),
  listBrowserVmRunIdsBetween:
    vi.fn<typeof browserVmRecords.listBrowserVmRunIdsBetween>(),
  listBrowserVmsToReconcile:
    vi.fn<typeof browserVmRecords.listBrowserVmsToReconcile>(),
  listOpenBrowserVmRuns: vi.fn<typeof browserVmRecords.listOpenBrowserVmRuns>(),
  readBrowserVm: vi.fn<typeof browserVmRecords.readBrowserVm>(),
  releaseBrowserVmLease: vi.fn<typeof browserVmRecords.releaseBrowserVmLease>(),
  updateBrowserVm: vi.fn<typeof browserVmRecords.updateBrowserVm>(),
}));

const listWorkspacesHoldingBrowsers = vi.hoisted(() =>
  vi.fn<(workspaceIds: readonly string[], now?: Date) => Promise<string[]>>()
);
const workspaceHasPendingBrowserErrand = vi.hoisted(() =>
  vi.fn<(workspaceId: string, now?: Date) => Promise<boolean>>()
);

const cloud = vi.hoisted(() => ({
  createCloudRuVm: vi.fn<typeof cloudRuModule.createCloudRuVm>(),
  deleteCloudRuBackupsOf: vi.fn<typeof cloudRuModule.deleteCloudRuBackupsOf>(),
  deleteCloudRuFloatingIp:
    vi.fn<typeof cloudRuModule.deleteCloudRuFloatingIp>(),
  deleteCloudRuVm: vi.fn<typeof cloudRuModule.deleteCloudRuVm>(),
  findCloudRuVmByName:
    vi.fn<(name: string) => ReturnType<typeof cloudRuModule.readCloudRuVm>>(),
  readCloudRuVm: vi.fn<typeof cloudRuModule.readCloudRuVm>(),
  setCloudRuVmPower: vi.fn<typeof cloudRuModule.setCloudRuVmPower>(),
}));

const worker = vi.hoisted(() => ({
  controlBrowserVmWorkerChrome:
    vi.fn<typeof workerModule.controlBrowserVmWorkerChrome>(),
  readBrowserVmWorkerHealth:
    vi.fn<typeof workerModule.readBrowserVmWorkerHealth>(),
  resetBrowserVmWorkerProfile:
    vi.fn<typeof workerModule.resetBrowserVmWorkerProfile>(),
  setBrowserVmWorkerProxy: vi.fn<typeof workerModule.setBrowserVmWorkerProxy>(),
  updateBrowserVmWorkerCode:
    vi.fn<typeof workerModule.updateBrowserVmWorkerCode>(),
}));

const clearOwnerAlert = vi.hoisted(() =>
  vi.fn<(key: string, now?: Date) => Promise<void>>(() => Promise.resolve())
);
const alertOwner = vi.hoisted(() =>
  vi.fn<
    (
      key: string,
      text: string,
      options: { readonly repeatAfterMs: number }
    ) => Promise<boolean>
  >()
);

/** The pause between two tries at the lease of a deletion. */
const sleep = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());

vi.mock("@db/services/browser-vms", () => records);
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof timersModule>()),
  setTimeout: sleep,
}));
vi.mock("@db/services/browser-runs", () => ({
  listWorkspacesHoldingBrowsers,
  workspaceHasPendingBrowserErrand,
}));
vi.mock("@agent/lib/browser-vm/cloudru", async (importOriginal) => ({
  ...(await importOriginal<typeof cloudRuModule>()),
  ...cloud,
}));
vi.mock("@agent/lib/browser-vm/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof workerModule>()),
  ...worker,
}));
vi.mock("@agent/lib/owner-alert", () => ({ alertOwner, clearOwnerAlert }));
// The reconcile also asks the pool, which has no host here.
vi.mock("@db/services/browser-hosts", () => ({
  listBrowserHosts: vi.fn<() => Promise<unknown[]>>(async () => []),
}));
const recordUsageCost = vi.hoisted(() =>
  vi.fn<typeof usageCostRecords.recordUsageCost>()
);
vi.mock("@db/services/usage-costs", () => ({ recordUsageCost }));

function minutesAgo(minutes: number) {
  return new Date(now.getTime() - minutes * 60_000);
}

function vmRow(overrides: Partial<BrowserVmRow> = {}): BrowserVmRow {
  return {
    bootDiskId: "disk-1",
    claimedAt: null,
    createdAt: minutesAgo(600),
    floatingIpId: "fip-1",
    generation: 1,
    givenUpAt: null,
    healthFailures: 0,
    host,
    hostId: null,
    image: "bro-browser-test-1",
    lastError: null,
    lastUsedAt: minutesAgo(1),
    leaseUntil: null,
    parkFailures: 0,
    parkRetryAt: null,
    poweredOnAt: null,
    profileGeneration: 1,
    profileResetPending: false,
    proxyExit: {
      at: minutesAgo(5).toISOString(),
      city: "Moscow",
      country: "RU",
      ip: "95.24.1.2",
      org: "AS8402 Beeline",
    },
    proxySession: null,
    recoveries: 0,
    sandboxState: null,
    snapshotChunks: null,
    snapshotFormat: null,
    snapshotGeneration: null,
    snapshotKey: null,
    state: "ready",
    stateChangedAt: minutesAgo(60),
    stopNotBefore: null,
    updatedAt: minutesAgo(1),
    vmId: "vm-1",
    vmName: "bro-personal0123456789ab-1",
    workerFailedVersion: null,
    workerRolloutAt: null,
    workspaceId,
    ...overrides,
  };
}

/** Whether a write or a release fenced by `leaseUntil` may land on the row. */
function sameLease(row: BrowserVmRow, leaseUntil: Date | undefined) {
  return (
    leaseUntil === undefined ||
    row.leaseUntil?.getTime() === leaseUntil.getTime()
  );
}

function stored() {
  const row = rows.get(workspaceId);
  if (row === undefined) throw new Error("The test VM record is gone.");
  return row;
}

function health(
  overrides: Partial<
    Awaited<ReturnType<typeof workerModule.readBrowserVmWorkerHealth>>
  > = {}
) {
  return {
    busy: false,
    chrome: true,
    configured: true,
    generation: 1,
    image: "bro-browser-test-1",
    proxy: true,
    stage: null,
    uptimeSeconds: 120,
    worker: "1",
    ...overrides,
  };
}

function cloudVm(
  state: string,
  overrides: { readonly floatingIpId?: string } = {}
) {
  return {
    bootDiskId: "disk-1",
    floatingIpId: "fip-1",
    host,
    id: "vm-1",
    state,
    ...overrides,
  };
}

function proxySetup(exit: {
  readonly country: string;
  readonly ip: string;
  readonly latencyMs?: number;
  readonly mbps?: number;
}) {
  return {
    chrome: true,
    exit: { city: "Somewhere", org: "AS1 Test", region: null, ...exit },
    traffic: { connections: 1, down: 0, refused: 0, up: 0 },
    vmAddress: host,
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
    updatedAt: minutesAgo(1),
    workspaceId,
  };
}

beforeEach(() => {
  rows.clear();
  records.readBrowserVm.mockImplementation((id) =>
    Promise.resolve(rows.get(id))
  );
  records.ensureBrowserVmRecord.mockImplementation((id) => {
    const row =
      rows.get(id) ??
      vmRow({
        bootDiskId: null,
        floatingIpId: null,
        generation: 0,
        host: null,
        image: null,
        lastUsedAt: null,
        proxyExit: null,
        state: "stopped",
        vmId: null,
        vmName: null,
        workspaceId: id,
      });
    rows.set(id, row);
    return Promise.resolve(row);
  });
  records.claimBrowserVmLease.mockImplementation((id, at, leaseMs) => {
    const row = rows.get(id);
    if (row === undefined || (row.leaseUntil !== null && row.leaseUntil > at)) {
      return Promise.resolve(undefined);
    }
    const claimed = {
      ...row,
      claimedAt: at,
      leaseUntil: new Date(at.getTime() + leaseMs),
    };
    rows.set(id, claimed);
    return Promise.resolve(claimed);
  });
  records.releaseBrowserVmLease.mockImplementation((id, leaseUntil) => {
    const row = rows.get(id);
    if (row !== undefined && sameLease(row, leaseUntil)) {
      rows.set(id, { ...row, leaseUntil: null });
    }
    return Promise.resolve();
  });
  records.updateBrowserVm.mockImplementation(
    (id, patch, at = new Date(), leaseUntil) => {
      const row = rows.get(id);
      if (row === undefined || !sameLease(row, leaseUntil)) {
        return Promise.reject(
          new Error(
            "The browser VM record is gone, or another step took its lease."
          )
        );
      }
      const next: BrowserVmRow = {
        ...row,
        ...patch,
        stateChangedAt:
          patch.state !== undefined && patch.state !== row.state
            ? at
            : row.stateChangedAt,
      };
      rows.set(id, next);
      return Promise.resolve(next);
    }
  );
  records.listBrowserVmsToReconcile.mockImplementation(() =>
    Promise.resolve([...rows.values()])
  );
  records.deleteBrowserVmRecord.mockImplementation((id) => {
    rows.delete(id);
    return Promise.resolve();
  });
  records.clearBrowserVmProfileReset.mockImplementation((id, generation) => {
    const row = rows.get(id);
    if (
      row === undefined ||
      !row.profileResetPending ||
      row.profileGeneration !== generation
    ) {
      return Promise.resolve(false);
    }
    rows.set(id, { ...row, profileResetPending: false });
    return Promise.resolve(true);
  });
  records.listOpenBrowserVmRuns.mockResolvedValue([]);
  records.listBrowserVmRunIdsBetween.mockResolvedValue([]);
  cloud.findCloudRuVmByName.mockResolvedValue(undefined);
  cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
  sleep.mockResolvedValue();
  listWorkspacesHoldingBrowsers.mockResolvedValue([]);
  workspaceHasPendingBrowserErrand.mockResolvedValue(false);
  cloud.setCloudRuVmPower.mockResolvedValue();
  cloud.deleteCloudRuVm.mockResolvedValue();
  cloud.deleteCloudRuFloatingIp.mockResolvedValue();
  cloud.deleteCloudRuBackupsOf.mockResolvedValue(0);
  worker.readBrowserVmWorkerHealth.mockResolvedValue(health());
  worker.controlBrowserVmWorkerChrome.mockResolvedValue({
    chrome: false,
    output: "",
    rc: 0,
  });
  worker.resetBrowserVmWorkerProfile.mockResolvedValue({
    chrome: true,
    reset: true,
  });
  alertOwner.mockResolvedValue(true);
  recordUsageCost.mockResolvedValue(true);
});

afterEach(() => {
  clearBrowserVmSettings();
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadLifecycle(settings: Record<string, string> = {}) {
  return importWithSettings(
    { ...browserVmTestEnvironment, ...settings },
    async () => import("@agent/lib/browser-vm/lifecycle")
  );
}

describe("rolling the published worker out before an errand", () => {
  const code = new TextEncoder().encode('VERSION = "2026-09-30.1"\n');
  const published = {
    BROWSER_STATE_BUCKET: "bro-state-test",
    BROWSER_VM_WORKER: `2026-09-30.1:workers/worker.py:${createHash("sha256")
      .update(code)
      .digest("hex")}`,
    CLOUDRU_S3_TENANT_ID: "test-tenant",
  };
  const objectStorage = vi.fn<() => Promise<Response>>();
  /** A VM the last errand left a while ago: nobody is setting it up. */
  const idleVm = (overrides: Partial<BrowserVmRow> = {}) =>
    vmRow({ lastUsedAt: minutesAgo(5), ...overrides });

  beforeEach(() => {
    objectStorage.mockReset();
    objectStorage.mockImplementation(async () => new Response(code));
    vi.stubGlobal("fetch", objectStorage);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    worker.updateBrowserVmWorkerCode.mockResolvedValue();
    worker.readBrowserVmWorkerHealth.mockReset();
    // Before the lease, under it, then the new version.
    worker.readBrowserVmWorkerHealth
      .mockResolvedValueOnce(health({ worker: "2026-09-29.1" }))
      .mockResolvedValueOnce(health({ worker: "2026-09-29.1" }))
      .mockResolvedValue(health({ worker: "2026-09-30.1" }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("updates an idle worker under the lease and hands the VM to the errand", async () => {
    const lifecycle = await loadLifecycle(published);
    rows.set(workspaceId, idleVm());

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result.kind).toBe("ready");
    expect(worker.updateBrowserVmWorkerCode).toHaveBeenCalledOnce();
    expect(records.claimBrowserVmLease).toHaveBeenCalledOnce();
    expect(stored().leaseUntil).toBeNull();
    expect(stored().workerRolloutAt).not.toBeNull();
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it("does nothing more when the worker is up to date by the time it holds the lease", async () => {
    const lifecycle = await loadLifecycle(published);
    rows.set(workspaceId, idleVm());
    worker.readBrowserVmWorkerHealth.mockReset();
    worker.readBrowserVmWorkerHealth
      .mockResolvedValueOnce(health({ worker: "2026-09-29.1" }))
      .mockResolvedValue(health({ worker: "2026-09-30.1" }));

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result.kind).toBe("ready");
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
    expect(stored().workerRolloutAt).toBeNull();
  });

  it("checks for runs before it takes the lease, and needs none for a VM in use", async () => {
    const lifecycle = await loadLifecycle(published);
    rows.set(workspaceId, idleVm());
    listWorkspacesHoldingBrowsers.mockResolvedValue([workspaceId]);

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result.kind).toBe("ready");
    expect(records.claimBrowserVmLease).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });

  it("keeps the errand on the old worker when the rollout fails", async () => {
    const lifecycle = await loadLifecycle(published);
    rows.set(workspaceId, idleVm());
    objectStorage.mockRejectedValue(new Error("timeout"));
    worker.readBrowserVmWorkerHealth.mockReset();
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ worker: "2026-09-29.1" })
    );

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result.kind).toBe("ready");
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
    expect(alertOwner).toHaveBeenCalledOnce();
    expect(stored().leaseUntil).toBeNull();
    // Not remembered, and not tried again by the next errand at once.
    expect(stored().workerFailedVersion).toBeNull();
    objectStorage.mockClear();
    rows.set(workspaceId, { ...stored(), lastUsedAt: minutesAgo(5) });
    await expect(lifecycle.ensureBrowserVm(workspaceId, now)).resolves.toEqual(
      expect.objectContaining({ kind: "ready" })
    );
    expect(objectStorage).not.toHaveBeenCalled();
  });

  it("lets the errand wait while a worker that took the code is not back yet", async () => {
    const lifecycle = await loadLifecycle(published);
    rows.set(workspaceId, idleVm());
    worker.readBrowserVmWorkerHealth.mockReset();
    worker.readBrowserVmWorkerHealth
      .mockResolvedValueOnce(health({ worker: "2026-09-29.1" }))
      .mockResolvedValueOnce(health({ worker: "2026-09-29.1" }))
      .mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 45_000 });
    expect(stored()).toMatchObject({
      leaseUntil: null,
      state: "ready",
      workerFailedVersion: "2026-09-30.1",
    });
  });

  it("goes on on the old worker while another step holds the VM for something else", async () => {
    const lifecycle = await loadLifecycle(published);
    rows.set(
      workspaceId,
      idleVm({ leaseUntil: new Date(Date.now() + 60_000) })
    );

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result.kind).toBe("ready");
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });

  it("lets the errand wait while another step is rolling a worker out", async () => {
    const lifecycle = await loadLifecycle(published);
    rows.set(
      workspaceId,
      idleVm({
        leaseUntil: new Date(Date.now() + 60_000),
        workerRolloutAt: new Date(Date.now() - 10_000),
      })
    );

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 60_000 });
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });

  it("asks nothing of the worker without BROWSER_VM_WORKER", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, idleVm());

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result.kind).toBe("ready");
    expect(records.claimBrowserVmLease).not.toHaveBeenCalled();
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });
});

describe("bringing a workspace's browser VM up for an errand", () => {
  it("creates the first VM under a new generation and asks the errand to wait for it", async () => {
    const lifecycle = await loadLifecycle();
    cloud.createCloudRuVm.mockResolvedValue({
      id: "vm-new",
      image: "bro-browser-test-1",
      name: "bro-personal0123456789ab-1",
    });

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 180_000 });
    expect(cloud.createCloudRuVm).toHaveBeenCalledOnce();
    const [created] = cloud.createCloudRuVm.mock.calls[0] ?? [];
    expect(created?.name).toBe("bro-personal0123456789ab-1");
    expect(created?.cloudInit).toContain(`"environment":"${workspaceId}"`);
    expect(stored()).toMatchObject({
      generation: 1,
      image: "bro-browser-test-1",
      leaseUntil: null,
      recoveries: 0,
      state: "creating",
      stateChangedAt: now,
      vmId: "vm-new",
    });
  });

  it("hands a VM whose worker is healthy to the errand and restarts its idle clock", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ lastUsedAt: minutesAgo(15) }));

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result.kind).toBe("ready");
    expect(stored().lastUsedAt).toEqual(now);
    expect(records.claimBrowserVmLease).not.toHaveBeenCalled();
    // Cloud.ru confirms the address is still this VM's before any secret goes.
    expect(cloud.readCloudRuVm).toHaveBeenCalledExactlyOnceWith("vm-1");
  });

  it("sends nothing to an address whose VM is gone from Cloud.ru, and forgets the VM", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ generation: 2 }));
    // Another machine got the address and answers health like our worker.
    cloud.readCloudRuVm.mockResolvedValue(undefined);

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 45_000 });
    expect(worker.setBrowserVmWorkerProxy).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({
      host: null,
      profileGeneration: 2,
      state: "stopped",
      vmId: null,
    });
    expect(records.releaseBrowserVmLease).toHaveBeenCalled();
  });

  it("follows a VM that Cloud.ru now has on another address", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow());
    cloud.readCloudRuVm.mockResolvedValue({
      ...cloudVm("running"),
      host: "203.0.113.9",
    });

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 45_000 });
    expect(worker.setBrowserVmWorkerProxy).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ host: "203.0.113.9", state: "ready" });
  });

  it("keeps the errand waiting while Cloud.ru cannot confirm the VM", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow();
    rows.set(workspaceId, vm);
    cloud.readCloudRuVm.mockRejectedValue(new TypeError("fetch failed"));

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 45_000 });
    expect(stored()).toEqual(vm);
    expect(records.claimBrowserVmLease).not.toHaveBeenCalled();
  });

  it.each([
    [
      "answers with Chrome down",
      () => Promise.resolve(health({ chrome: false })),
    ],
    ["does not answer", () => Promise.reject(new TypeError("fetch failed"))],
  ])(
    "keeps a ready VM whose worker %s as it is, and the errand waits",
    async (_how, answer) => {
      const lifecycle = await loadLifecycle();
      const vm = vmRow({ lastUsedAt: minutesAgo(15) });
      rows.set(workspaceId, vm);
      worker.readBrowserVmWorkerHealth.mockImplementation(answer);
      cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));

      const result = await lifecycle.ensureBrowserVm(workspaceId, now);

      expect(result).toEqual({ kind: "starting", retryAfterMs: 45_000 });
      // One missed answer is not written down: only the reconcile demotes.
      expect(stored()).toEqual(vm);
      expect(records.updateBrowserVm).not.toHaveBeenCalled();
      expect(records.claimBrowserVmLease).not.toHaveBeenCalled();
      expect(cloud.readCloudRuVm).not.toHaveBeenCalled();
      expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    }
  );

  it("hands the VM to the errand while its worker is busy with a run", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow());
    // Chrome restarting under a run: the run is proof the worker is alive.
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ busy: true, chrome: false })
    );

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result.kind).toBe("ready");
    expect(stored()).toMatchObject({ lastUsedAt: now, state: "ready" });
  });

  it("keeps errands off a ready VM until the profile the person forgot is wiped", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ profileGeneration: 2, profileResetPending: true });
    rows.set(workspaceId, vm);

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 45_000 });
    expect(stored()).toEqual(vm);
  });

  it("powers a stopped VM on, keeping its disk and the profile on it", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ recoveries: 1, state: "stopped" }));
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("stopped"));

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 60_000 });
    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-1",
      "power_on"
    );
    expect(cloud.createCloudRuVm).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ recoveries: 0, state: "starting" });
  });

  it("creates a new VM when the stopped one is gone from Cloud.ru, on a new profile", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ generation: 2, state: "stopped" }));
    cloud.readCloudRuVm.mockResolvedValue(undefined);
    cloud.createCloudRuVm.mockResolvedValue({
      id: "vm-2",
      image: "bro-browser-test-1",
      name: "bro-personal0123456789ab-3",
    });

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 180_000 });
    expect(cloud.createCloudRuVm.mock.calls[0]?.[0].name).toBe(
      "bro-personal0123456789ab-3"
    );
    // The old VM's address may have outlived it, billed on its own.
    expect(cloud.deleteCloudRuFloatingIp).toHaveBeenCalledExactlyOnceWith(
      "fip-1"
    );
    // So can a backup of its disk — a copy of the person's browser profile —
    // and it must not outlive their account either.
    expect(cloud.deleteCloudRuBackupsOf).toHaveBeenCalledExactlyOnceWith([
      "disk-1",
    ]);
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({
      generation: 3,
      host: null,
      profileGeneration: 2,
      state: "creating",
      vmId: "vm-2",
    });
  });

  it("does not create a second VM when another caller took the VM over during a slow step", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ generation: 2, state: "stopped" }));
    const theirLease = new Date(now.getTime() + 150_000);
    // The read outlives the lease; meanwhile another caller claims the VM
    // and creates its replacement.
    cloud.readCloudRuVm.mockImplementation(() => {
      rows.set(workspaceId, {
        ...stored(),
        floatingIpId: null,
        generation: 3,
        leaseUntil: theirLease,
        state: "creating",
        vmId: "vm-theirs",
      });
      return Promise.resolve(undefined);
    });

    await expect(lifecycle.ensureBrowserVm(workspaceId, now)).rejects.toThrow(
      "another step took its lease"
    );

    expect(cloud.createCloudRuVm).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({
      generation: 3,
      leaseUntil: theirLease,
      state: "creating",
      vmId: "vm-theirs",
    });
  });

  it("asks the errand back in a minute when Cloud.ru could not be asked to create the VM", async () => {
    const lifecycle = await loadLifecycle();
    const { CloudRuUnsentError } =
      await import("@agent/lib/browser-vm/cloudru");
    cloud.createCloudRuVm.mockRejectedValueOnce(
      new CloudRuUnsentError(new Error("Cloud.ru 403 on /api/v1/auth/token"))
    );

    const refused = await lifecycle
      .ensureBrowserVm(workspaceId, now)
      .catch((cause: unknown) => cause);

    expect(refused).toMatchObject({
      name: "BrowserUseError",
      retryAfterMs: 60_000,
      status: 429,
    });
    // Nothing was sent, so there is no VM to wait twenty minutes for.
    expect(stored()).toMatchObject({
      leaseUntil: null,
      state: "failed",
      vmId: null,
    });
    expect(stored().lastError).toContain("auth/token");
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      "cloudru-access",
      expect.stringContaining("CLOUDRU_KEY_ID"),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );

    cloud.createCloudRuVm.mockResolvedValue({
      id: "vm-new",
      image: "bro-browser-test-1",
      name: "bro-personal0123456789ab-2",
    });
    expect(
      await lifecycle.ensureBrowserVm(
        workspaceId,
        new Date(now.getTime() + 60_000)
      )
    ).toEqual({ kind: "starting", retryAfterMs: 180_000 });
    expect(stored()).toMatchObject({ state: "creating", vmId: "vm-new" });
  });

  it("tells a second errand to wait while another caller holds the lease", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ leaseUntil: new Date(now.getTime() + 60_000), state: "stopped" })
    );

    const result = await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(result).toEqual({ kind: "starting", retryAfterMs: 60_000 });
    expect(cloud.readCloudRuVm).not.toHaveBeenCalled();
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
  });

  it("queues the errand for ten minutes and tells the owner when Cloud.ru is out of quota", async () => {
    const lifecycle = await loadLifecycle();
    const { CloudRuError } = await import("@agent/lib/browser-vm/cloudru");
    cloud.createCloudRuVm.mockRejectedValue(
      new CloudRuError(403, "/api/v1.1/vms", '{"message":"quota exceeded"}')
    );

    const refused = await lifecycle
      .ensureBrowserVm(workspaceId, now)
      .catch((cause: unknown) => cause);

    expect(refused).toMatchObject({
      name: "BrowserUseError",
      retryAfterMs: 10 * 60_000,
      status: 429,
    });
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      "cloudru-quota",
      expect.stringContaining("квота"),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );
    expect(stored()).toMatchObject({
      leaseUntil: null,
      poweredOnAt: null,
      state: "failed",
    });
    expect(stored().lastError).toContain("quota exceeded");
    // The refused create never had a VM on: nothing is billed for it.
    expect(recordUsageCost).not.toHaveBeenCalled();
  });
});

describe("reconciling browser VMs", () => {
  it("marks a started VM ready once its worker is healthy, wiping a profile forgotten while it was off", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        host: null,
        lastUsedAt: minutesAgo(90),
        profileResetPending: true,
        state: "starting",
        stateChangedAt: minutesAgo(2),
      })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));

    await lifecycle.reconcileBrowserVms(now);

    expect(worker.resetBrowserVmWorkerProfile).toHaveBeenCalledOnce();
    expect(stored()).toMatchObject({
      host,
      lastUsedAt: now,
      leaseUntil: null,
      profileResetPending: false,
      state: "ready",
    });
  });

  it("reboots a VM with no healthy worker four minutes after it was started, once", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "starting", stateChangedAt: minutesAgo(8) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
    worker.readBrowserVmWorkerHealth.mockRejectedValue(
      new TypeError("fetch failed")
    );

    await lifecycle.reconcileBrowserVms(now);
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-1",
      "reboot"
    );
    expect(stored()).toMatchObject({ recoveries: 1, state: "starting" });
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it("waits for a VM that is still inside its first four minutes", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "creating", stateChangedAt: minutesAgo(3) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ configured: false })
    );

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    expect(stored().state).toBe("creating");
  });

  it("gives a VM up after twenty minutes, tells the owner and powers it off, without deleting it", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        recoveries: 1,
        state: "starting",
        stateChangedAt: minutesAgo(21),
      })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
    worker.readBrowserVmWorkerHealth.mockRejectedValue(
      new TypeError("fetch failed")
    );

    await lifecycle.reconcileBrowserVms(now);

    expect(stored()).toMatchObject({ leaseUntil: null, state: "failed" });
    expect(stored().lastError).toContain("20 minutes");
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      `browser-vm-failed:${workspaceId}`,
      expect.stringContaining("не поднялась"),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );
    // Off, not deleted: its disk holds the person's profile.
    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-1",
      "power_off"
    );
    expect(cloud.deleteCloudRuVm).not.toHaveBeenCalled();
  });

  it("lets a VM go that never came up from its create, so the next errand creates a new one", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        recoveries: 1,
        state: "creating",
        stateChangedAt: minutesAgo(21),
      })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("creating"));

    await lifecycle.reconcileBrowserVms(now);

    expect(stored()).toMatchObject({
      bootDiskId: null,
      floatingIpId: null,
      host: null,
      state: "failed",
      vmId: null,
    });
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      `browser-vm-create-failed:${workspaceId}`,
      expect.stringContaining("vm-1"),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );
    // Nothing of the person's is on it, so it goes with its disk and address.
    expect(cloud.deleteCloudRuVm).toHaveBeenCalledExactlyOnceWith("vm-1", {
      diskIds: ["disk-1"],
      floatingIpIds: ["fip-1"],
    });
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
  });

  it("waits for a floating IP still settling before giving an abandoned VM's ids up, instead of losing it", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        floatingIpId: null,
        recoveries: 1,
        state: "creating",
        stateChangedAt: minutesAgo(21),
      })
    );
    // The VM's address "comes a little after the VM itself": the first two
    // reads show none yet, and it only shows up on the third.
    cloud.readCloudRuVm
      .mockResolvedValueOnce(cloudVm("creating", { floatingIpId: undefined }))
      .mockResolvedValueOnce(cloudVm("creating", { floatingIpId: undefined }))
      .mockResolvedValue(cloudVm("creating", { floatingIpId: "fip-late" }));

    await lifecycle.reconcileBrowserVms(now);

    // The address it eventually found is named, so Cloud.ru releases it with
    // the VM instead of leaving it billed with no id anywhere to find it by.
    expect(cloud.deleteCloudRuVm).toHaveBeenCalledExactlyOnceWith("vm-1", {
      diskIds: ["disk-1"],
      floatingIpIds: ["fip-late"],
    });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("neither reboots nor gives up a VM while a run on it may still be going", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "starting", stateChangedAt: minutesAgo(21) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
    worker.readBrowserVmWorkerHealth.mockRejectedValue(
      new TypeError("fetch failed")
    );
    records.listOpenBrowserVmRuns.mockResolvedValue([openRun(minutesAgo(29))]);

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    expect(alertOwner).not.toHaveBeenCalled();
    expect(stored().state).toBe("starting");

    // Once the run is older than any the worker would still be on, the
    // watchdog goes on.
    records.listOpenBrowserVmRuns.mockResolvedValue([openRun(minutesAgo(31))]);
    await lifecycle.reconcileBrowserVms(now);

    expect(stored().state).toBe("failed");
  });

  it("finds a VM whose create lost its answer by its name, and follows it up", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        bootDiskId: null,
        floatingIpId: null,
        host: null,
        state: "creating",
        stateChangedAt: minutesAgo(4),
        vmId: null,
      })
    );
    cloud.findCloudRuVmByName.mockResolvedValue(cloudVm("running"));

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.findCloudRuVmByName).toHaveBeenCalledExactlyOnceWith(
      "bro-personal0123456789ab-1"
    );
    expect(stored()).toMatchObject({
      bootDiskId: "disk-1",
      floatingIpId: "fip-1",
      host,
      state: "ready",
      vmId: "vm-1",
    });
  });

  it("gives a create up that no VM of its name answered, and tells the owner", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        host: null,
        state: "creating",
        stateChangedAt: minutesAgo(21),
        vmId: null,
      })
    );

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.findCloudRuVmByName).toHaveBeenCalledOnce();
    expect(stored().state).toBe("failed");
    expect(stored().lastError).toContain("never confirmed created");
    expect(alertOwner).toHaveBeenCalledOnce();
  });

  it("keeps an abandoned VM's ids when its delete fails, so the next reconcile tries the give-up again", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "creating", stateChangedAt: minutesAgo(21) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("creating"));
    cloud.deleteCloudRuVm.mockRejectedValueOnce(new TypeError("fetch failed"));

    await lifecycle.reconcileBrowserVms(now);

    // The delete never landed: the ids stay so the VM is not lost track of
    // and left billing, and the state stays `creating` so the reconcile
    // tries the give-up again rather than treating it as settled.
    expect(stored()).toMatchObject({
      bootDiskId: "disk-1",
      floatingIpId: "fip-1",
      state: "creating",
      vmId: "vm-1",
    });
    expect(alertOwner).not.toHaveBeenCalled();
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();

    cloud.deleteCloudRuVm.mockResolvedValue();
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(cloud.deleteCloudRuVm).toHaveBeenCalledTimes(2);
    expect(stored()).toMatchObject({
      bootDiskId: null,
      floatingIpId: null,
      state: "failed",
      vmId: null,
    });
    expect(alertOwner).toHaveBeenCalledOnce();
  });

  it("gives an abandoned VM's ids up when Cloud.ru refuses to delete it, and tells the owner to remove it", async () => {
    const lifecycle = await loadLifecycle();
    const { CloudRuError } = await import("@agent/lib/browser-vm/cloudru");
    rows.set(
      workspaceId,
      vmRow({ state: "creating", stateChangedAt: minutesAgo(21) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("creating"));
    cloud.deleteCloudRuVm.mockRejectedValue(
      new CloudRuError(
        422,
        "/api/v1/vms/vm-1",
        '{"message":"cannot be deleted from its current state"}'
      )
    );

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.deleteCloudRuVm).toHaveBeenCalledOnce();
    expect(stored()).toMatchObject({
      bootDiskId: null,
      floatingIpId: null,
      host: null,
      state: "failed",
      vmId: null,
    });
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      `browser-vm-create-failed:${workspaceId}`,
      expect.stringContaining("vm-1"),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );
  });

  it("takes a ready VM out of service only after its worker missed three checks in a row", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ lastUsedAt: minutesAgo(30), recoveries: 1 }));
    worker.readBrowserVmWorkerHealth.mockRejectedValue(
      new TypeError("fetch failed")
    );

    await lifecycle.reconcileBrowserVms(now);
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(stored()).toMatchObject({ healthFailures: 2, state: "ready" });
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();

    // An answer in between starts the count over.
    worker.readBrowserVmWorkerHealth.mockResolvedValueOnce(
      health({ busy: true })
    );
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 120_000));
    expect(stored()).toMatchObject({ healthFailures: 0, state: "ready" });

    const later = (minutes: number) =>
      new Date(now.getTime() + minutes * 60_000);
    await lifecycle.reconcileBrowserVms(later(3));
    await lifecycle.reconcileBrowserVms(later(4));
    expect(stored().state).toBe("ready");
    await lifecycle.reconcileBrowserVms(later(5));

    // The watchdog takes it from here, with its reboot still to spend.
    expect(stored()).toMatchObject({
      healthFailures: 0,
      recoveries: 0,
      state: "starting",
      stateChangedAt: later(5),
    });
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    expect(worker.controlBrowserVmWorkerChrome).not.toHaveBeenCalled();
  });

  it("stops a VM nobody used for the idle window, Chrome first so it keeps its cookies", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ lastUsedAt: minutesAgo(21) }));

    await lifecycle.reconcileBrowserVms(now);

    expect(worker.controlBrowserVmWorkerChrome).toHaveBeenCalledOnce();
    expect(worker.controlBrowserVmWorkerChrome.mock.calls[0]?.[1]).toBe("stop");
    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-1",
      "power_off"
    );
    expect(
      worker.controlBrowserVmWorkerChrome.mock.invocationCallOrder[0]
    ).toBeLessThan(cloud.setCloudRuVmPower.mock.invocationCallOrder[0] ?? 0);
    expect(stored()).toMatchObject({ leaseUntil: null, state: "stopping" });
  });

  it.each([
    [
      "an errand used it within the window",
      () => {
        rows.set(workspaceId, vmRow({ lastUsedAt: minutesAgo(19) }));
      },
    ],
    [
      "a run on it is still open",
      () => {
        records.listOpenBrowserVmRuns.mockResolvedValue([
          openRun(minutesAgo(30)),
        ]);
      },
    ],
    [
      "an errand's page is still kept in its browser",
      () => {
        listWorkspacesHoldingBrowsers.mockResolvedValue([workspaceId]);
      },
    ],
    [
      "the worker says a run holds the browser",
      () => {
        worker.readBrowserVmWorkerHealth.mockResolvedValue(
          health({ busy: true })
        );
      },
    ],
    [
      "an errand is queued or parked for it, or its report is on its way",
      () => {
        workspaceHasPendingBrowserErrand.mockResolvedValue(true);
      },
    ],
  ])("keeps the VM up while %s", async (_reason, arrange) => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ lastUsedAt: minutesAgo(45) }));
    arrange();

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    expect(worker.controlBrowserVmWorkerChrome).not.toHaveBeenCalled();
    expect(stored().state).toBe("ready");
  });

  it.each([
    ["a person's errand, unused for the idle window", null, 21, true],
    ["a person's errand, used within the idle window", null, 19, false],
    ["an errand nobody waits for, past its stop time", -1, 3, true],
    ["an errand nobody waits for, used within the grace", -1, 1, false],
    ["a code wait, before its deadline", 5, 30, false],
    ["a code wait, past its deadline", -1, 30, true],
  ] as const)(
    "decides the idle stop by who woke the VM: %s",
    async (_case, stopInMinutes, unusedMinutes, stops) => {
      const lifecycle = await loadLifecycle();
      rows.set(
        workspaceId,
        vmRow({
          lastUsedAt: minutesAgo(unusedMinutes),
          stopNotBefore:
            stopInMinutes === null ? null : minutesAgo(-stopInMinutes),
        })
      );

      await lifecycle.reconcileBrowserVms(now);

      expect(stored().state).toBe(stops ? "stopping" : "ready");
      expect(cloud.setCloudRuVmPower).toHaveBeenCalledTimes(stops ? 1 : 0);
    }
  );

  it("keeps a VM up when its stop time moved while it was being stopped", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ lastUsedAt: minutesAgo(10), stopNotBefore: minutesAgo(1) })
    );
    // A person's errand puts the VM back on their window in the meantime.
    workspaceHasPendingBrowserErrand.mockImplementation(() => {
      rows.set(workspaceId, { ...stored(), stopNotBefore: null });
      return Promise.resolve(false);
    });

    await lifecycle.reconcileBrowserVms(now);

    expect(stored().state).toBe("ready");
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    expect(worker.controlBrowserVmWorkerChrome).not.toHaveBeenCalled();
  });

  it("settles a VM that finished powering off as stopped", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "stopping", stateChangedAt: minutesAgo(1) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("stopped"));

    await lifecycle.reconcileBrowserVms(now);

    expect(stored()).toMatchObject({ state: "stopped", vmId: "vm-1" });
  });

  it("records the hour a VM was on once it settles as stopped, and only once", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        poweredOnAt: minutesAgo(60),
        state: "stopping",
        stateChangedAt: minutesAgo(1),
      })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("stopped"));

    await lifecycle.reconcileBrowserVms(now);
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(stored()).toMatchObject({ poweredOnAt: null, state: "stopped" });
    expect(recordUsageCost).toHaveBeenCalledExactlyOnceWith({
      costRub: 2.97,
      costUsd: null,
      idempotencyKey: `browser-vm:${workspaceId}:${minutesAgo(60).toISOString()}`,
      occurredAt: now,
      runId: null,
      sessionId: null,
      source: "browser-vm",
      units: { flavor: "gen-2-4", seconds: 3600, sharedBy: 1 },
      workspaceId,
    });
  });

  it("starts the VM's clock when it powers the VM on", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ state: "stopped" }));
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("stopped"));

    await lifecycle.ensureBrowserVm(workspaceId, now);

    expect(stored()).toMatchObject({ poweredOnAt: now, state: "starting" });
    expect(recordUsageCost).not.toHaveBeenCalled();
  });

  it("stops the VM as before when its time cannot be recorded, and records it on the next start", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ poweredOnAt: minutesAgo(30), state: "stopping" })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("stopped"));
    recordUsageCost.mockRejectedValueOnce(new Error("database is down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await lifecycle.reconcileBrowserVms(now);

    // The start stays until the stretch is on record.
    expect(stored()).toMatchObject({
      poweredOnAt: minutesAgo(30),
      state: "stopped",
    });

    const later = new Date(now.getTime() + 3 * 60 * 60_000);
    await lifecycle.ensureBrowserVm(workspaceId, later);

    // Recorded up to the stop, not through the three hours it was off.
    expect(recordUsageCost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: `browser-vm:${workspaceId}:${minutesAgo(30).toISOString()}`,
        occurredAt: now,
        units: { flavor: "gen-2-4", seconds: 1800, sharedBy: 1 },
      })
    );
    expect(stored()).toMatchObject({ poweredOnAt: later, state: "starting" });
  });

  it("shares the time a VM was on between the errands that ran on it", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        poweredOnAt: minutesAgo(60),
        state: "stopping",
        stateChangedAt: minutesAgo(1),
      })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("stopped"));
    records.listBrowserVmRunIdsBetween.mockResolvedValue(["run-a", "run-b"]);

    await lifecycle.reconcileBrowserVms(now);

    const key = `browser-vm:${workspaceId}:${minutesAgo(60).toISOString()}`;
    expect(records.listBrowserVmRunIdsBetween).toHaveBeenCalledWith(
      workspaceId,
      minutesAgo(60),
      now
    );
    expect(recordUsageCost).toHaveBeenCalledTimes(2);
    expect(recordUsageCost).toHaveBeenCalledWith(
      expect.objectContaining({
        costRub: 1.485,
        idempotencyKey: `${key}:run-a`,
        runId: "run-a",
        units: { flavor: "gen-2-4", seconds: 1800, sharedBy: 2 },
      })
    );
    expect(recordUsageCost).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `${key}:run-b`,
        runId: "run-b",
      })
    );
    expect(stored().poweredOnAt).toBeNull();
  });

  it("keeps a deleted VM's record while its time cannot be recorded", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        poweredOnAt: minutesAgo(20),
        state: "deleting",
        stateChangedAt: minutesAgo(1),
      })
    );
    cloud.readCloudRuVm.mockResolvedValue(undefined);
    recordUsageCost.mockRejectedValueOnce(new Error("database is down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await lifecycle.reconcileBrowserVms(now);

    expect(rows.has(workspaceId)).toBe(true);

    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(rows.has(workspaceId)).toBe(false);
  });

  it("records the time a deleted VM was still on", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ poweredOnAt: minutesAgo(20), state: "deleting" })
    );
    cloud.readCloudRuVm.mockResolvedValue(undefined);

    await lifecycle.reconcileBrowserVms(now);

    expect(rows.has(workspaceId)).toBe(false);
    expect(recordUsageCost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        costRub: 0.99,
        source: "browser-vm",
        units: { flavor: "gen-2-4", seconds: 1200, sharedBy: 1 },
      })
    );
  });

  it("finishes a deletion that was left half done", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow({ state: "deleting" }));
    cloud.readCloudRuVm.mockResolvedValue(undefined);

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.deleteCloudRuFloatingIp).toHaveBeenCalledExactlyOnceWith(
      "fip-1"
    );
    expect(cloud.deleteCloudRuBackupsOf).toHaveBeenCalledExactlyOnceWith([
      "disk-1",
    ]);
    expect(rows.has(workspaceId)).toBe(false);
  });

  it("keeps the flag of a forget that came in while the VM was coming up", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "starting", stateChangedAt: minutesAgo(2) })
    );
    // The person forgets the sign-ins while the reconcile looks the VM up.
    cloud.readCloudRuVm.mockImplementationOnce(() => {
      rows.set(workspaceId, {
        ...stored(),
        profileGeneration: 2,
        profileResetPending: true,
      });
      return Promise.resolve(cloudVm("running"));
    });

    await lifecycle.reconcileBrowserVms(now);

    expect(worker.resetBrowserVmWorkerProfile).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({
      profileGeneration: 2,
      profileResetPending: true,
      state: "ready",
    });

    // The ready VM is wiped on the next pass, and only then free again.
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(worker.resetBrowserVmWorkerProfile).toHaveBeenCalledOnce();
    expect(stored()).toMatchObject({
      profileResetPending: false,
      state: "ready",
    });
  });

  it("leaves the flag set when the person forgot once more during the wipe", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ profileGeneration: 2, profileResetPending: true })
    );
    worker.resetBrowserVmWorkerProfile.mockImplementationOnce(() => {
      rows.set(workspaceId, { ...stored(), profileGeneration: 3 });
      return Promise.resolve({ chrome: true, reset: true });
    });

    await lifecycle.reconcileBrowserVms(now);

    expect(records.clearBrowserVmProfileReset).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      2,
      now
    );
    expect(stored()).toMatchObject({
      profileGeneration: 3,
      profileResetPending: true,
    });
  });

  it("does not wipe the profile under a run", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ profileGeneration: 2, profileResetPending: true })
    );
    worker.readBrowserVmWorkerHealth.mockResolvedValue(health({ busy: true }));

    await lifecycle.reconcileBrowserVms(now);

    expect(worker.resetBrowserVmWorkerProfile).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({
      profileResetPending: true,
      state: "ready",
    });
  });

  it("powers a stopped VM on to wipe a profile the person forgot", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        profileGeneration: 2,
        profileResetPending: true,
        state: "stopped",
      })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("stopped"));

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-1",
      "power_on"
    );
    expect(stored()).toMatchObject({
      profileResetPending: true,
      state: "starting",
    });

    // Up again, it is wiped before anything runs on it.
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(worker.resetBrowserVmWorkerProfile).toHaveBeenCalledOnce();
    expect(stored()).toMatchObject({
      profileResetPending: false,
      state: "ready",
    });
  });

  it("leaves a VM it gave up on off, and the wipe of a forgotten profile to the next errand", async () => {
    const lifecycle = await loadLifecycle();
    const later = (minutes: number) =>
      new Date(now.getTime() + minutes * 60_000);
    // Powered on to wipe a forgotten profile, and never healthy since.
    rows.set(
      workspaceId,
      vmRow({
        profileGeneration: 2,
        profileResetPending: true,
        recoveries: 1,
        state: "starting",
        stateChangedAt: minutesAgo(21),
      })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
    worker.readBrowserVmWorkerHealth.mockRejectedValue(
      new TypeError("fetch failed")
    );

    await lifecycle.reconcileBrowserVms(now);

    expect(stored()).toMatchObject({ givenUpAt: now, state: "failed" });
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      `browser-vm-failed:${workspaceId}`,
      expect.stringContaining("больше не включает"),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("stopped"));
    await lifecycle.reconcileBrowserVms(later(1));
    expect(stored().state).toBe("stopped");

    cloud.setCloudRuVmPower.mockClear();
    await lifecycle.reconcileBrowserVms(later(2));
    await lifecycle.reconcileBrowserVms(later(30));

    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({
      profileResetPending: true,
      state: "stopped",
    });

    // An errand still starts it, and once it is up it is wiped first and
    // no longer given up on.
    await lifecycle.ensureBrowserVm(workspaceId, later(31));
    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-1",
      "power_on"
    );
    expect(stored()).toMatchObject({ givenUpAt: now, state: "starting" });
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
    worker.readBrowserVmWorkerHealth.mockResolvedValue(health());
    await lifecycle.reconcileBrowserVms(later(32));

    expect(worker.resetBrowserVmWorkerProfile).toHaveBeenCalledOnce();
    expect(stored()).toMatchObject({
      givenUpAt: null,
      profileResetPending: false,
      state: "ready",
    });
  });

  it("releases the address of a VM gone from Cloud.ru, and keeps it on record until it is released", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "stopping", stateChangedAt: minutesAgo(1) })
    );
    cloud.readCloudRuVm.mockResolvedValue(undefined);
    cloud.deleteCloudRuFloatingIp.mockRejectedValueOnce(
      new TypeError("fetch failed")
    );

    await lifecycle.reconcileBrowserVms(now);

    expect(stored()).toMatchObject({
      floatingIpId: "fip-1",
      state: "stopping",
      vmId: "vm-1",
    });

    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(cloud.deleteCloudRuFloatingIp).toHaveBeenCalledTimes(2);
    expect(cloud.deleteCloudRuFloatingIp).toHaveBeenLastCalledWith("fip-1");
    expect(stored()).toMatchObject({
      floatingIpId: null,
      profileGeneration: 2,
      state: "stopped",
      vmId: null,
    });
  });

  it("sends a power-off that did not take again", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "stopping", stateChangedAt: minutesAgo(8) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-1",
      "power_off"
    );
    expect(stored().state).toBe("stopping");
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it("hands a VM that did not power off in fifteen minutes to the owner", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "stopping", stateChangedAt: minutesAgo(16) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));

    await lifecycle.reconcileBrowserVms(now);

    expect(stored()).toMatchObject({ state: "failed", vmId: "vm-1" });
    expect(stored().lastError).toContain("15 minutes");
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(workspaceId),
      expect.stringContaining("не выключилась"),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );
  });

  it("keeps a VM that did not delete in fifteen minutes `deleting`, tells the owner, and keeps retrying the delete", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "deleting", stateChangedAt: minutesAgo(16) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("deleting"));

    await lifecycle.reconcileBrowserVms(now);

    // Never demoted to `failed`: that state is the one an ordinary errand's
    // `ensureBrowserVm` is free to restart, which would silently undo the
    // deletion the caller relies on being final.
    expect(stored()).toMatchObject({ state: "deleting", vmId: "vm-1" });
    expect(stored().lastError).toContain("15 minutes");
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(workspaceId),
      expect.stringContaining("не удалилась"),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );

    // The reconcile keeps retrying the delete every minute rather than
    // abandoning it: Cloud.ru finally lets go of the VM on the next try.
    cloud.readCloudRuVm.mockResolvedValue(undefined);
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(rows.has(workspaceId)).toBe(false);
  });

  it("refuses to restart a VM whose deletion was given up on, even once an ordinary errand asks", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ state: "deleting", stateChangedAt: minutesAgo(16) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("deleting"));

    await lifecycle.reconcileBrowserVms(now);
    expect(stored().state).toBe("deleting");

    // An ordinary errand's ensureBrowserVm must not power it back on: it
    // waits instead, exactly as it would for any VM still on its way down.
    const result = await lifecycle.ensureBrowserVm(
      workspaceId,
      new Date(now.getTime() + 60_000)
    );

    expect(result).toEqual({ kind: "starting", retryAfterMs: 45_000 });
    expect(stored().state).toBe("deleting");
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    expect(cloud.createCloudRuVm).not.toHaveBeenCalled();
  });

  it("powers a failed VM off, and counts it stopped once it is off", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ lastError: "The VM did not answer.", state: "failed" })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));

    await lifecycle.reconcileBrowserVms(now);

    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-1",
      "power_off"
    );
    expect(stored().state).toBe("failed");

    cloud.readCloudRuVm.mockResolvedValue(cloudVm("stopped"));
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));

    expect(stored()).toMatchObject({
      lastError: "The VM did not answer.",
      state: "stopped",
      vmId: "vm-1",
    });
  });
});

describe("deleting a workspace's browser VM", () => {
  it("deletes the VM with its disk and address, and the record once Cloud.ru no longer knows it", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow());
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));

    expect(await lifecycle.deleteBrowserVm(workspaceId, now)).toBe(false);

    expect(cloud.deleteCloudRuVm).toHaveBeenCalledExactlyOnceWith("vm-1", {
      diskIds: ["disk-1"],
      floatingIpIds: ["fip-1"],
    });
    // Cloud.ru still knows the VM: the record is the trace of what is billed.
    expect(stored()).toMatchObject({ leaseUntil: null, state: "deleting" });
    expect(cloud.deleteCloudRuBackupsOf).not.toHaveBeenCalled();

    // Still being deleted a minute on: nothing is asked twice.
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("deleting"));
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 60_000));
    expect(cloud.deleteCloudRuVm).toHaveBeenCalledOnce();
    expect(stored().state).toBe("deleting");

    cloud.readCloudRuVm.mockResolvedValue(undefined);
    await lifecycle.reconcileBrowserVms(new Date(now.getTime() + 120_000));

    expect(cloud.deleteCloudRuFloatingIp).toHaveBeenCalledExactlyOnceWith(
      "fip-1"
    );
    expect(cloud.deleteCloudRuBackupsOf).toHaveBeenCalledExactlyOnceWith([
      "disk-1",
    ]);
    expect(rows.has(workspaceId)).toBe(false);
  });

  it("keeps the record, marked for deletion, when Cloud.ru did not take it", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(workspaceId, vmRow());
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
    cloud.deleteCloudRuVm.mockRejectedValue(new TypeError("fetch failed"));

    await expect(lifecycle.deleteBrowserVm(workspaceId, now)).rejects.toThrow(
      "fetch failed"
    );

    expect(stored()).toMatchObject({ leaseUntil: null, state: "deleting" });
  });

  it("waits for another step on the VM to end before it deletes", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({ leaseUntil: new Date(now.getTime() + 60_000) })
    );
    cloud.readCloudRuVm.mockResolvedValue(cloudVm("running"));
    // The errand holding the lease finishes its step three seconds on.
    sleep.mockImplementation(() => {
      if (sleep.mock.calls.length === 3) {
        rows.set(workspaceId, { ...stored(), leaseUntil: null });
      }
      return Promise.resolve();
    });

    expect(await lifecycle.deleteBrowserVm(workspaceId, now)).toBe(false);

    expect(sleep).toHaveBeenCalledTimes(3);
    expect(cloud.deleteCloudRuVm).toHaveBeenCalledOnce();
    expect(stored().state).toBe("deleting");
  });

  it("does not start a deletion while another step keeps the VM", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ leaseUntil: new Date(now.getTime() + 120_000) });
    rows.set(workspaceId, vm);

    await expect(lifecycle.deleteBrowserVm(workspaceId, now)).rejects.toThrow(
      "busy"
    );

    expect(stored()).toEqual(vm);
    expect(cloud.readCloudRuVm).not.toHaveBeenCalled();
    expect(cloud.deleteCloudRuVm).not.toHaveBeenCalled();
  });

  it("looks a VM whose create lost its answer up by its name before dropping the record", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        bootDiskId: null,
        floatingIpId: null,
        host: null,
        state: "creating",
        vmId: null,
      })
    );
    cloud.findCloudRuVmByName.mockResolvedValue(cloudVm("running"));

    expect(await lifecycle.deleteBrowserVm(workspaceId, now)).toBe(false);

    expect(cloud.findCloudRuVmByName).toHaveBeenCalledExactlyOnceWith(
      "bro-personal0123456789ab-1"
    );
    expect(cloud.deleteCloudRuVm).toHaveBeenCalledExactlyOnceWith("vm-1", {
      diskIds: ["disk-1"],
      floatingIpIds: ["fip-1"],
    });
    expect(stored()).toMatchObject({ state: "deleting", vmId: "vm-1" });
  });

  it("drops a record whose create left no VM behind", async () => {
    const lifecycle = await loadLifecycle();
    rows.set(
      workspaceId,
      vmRow({
        bootDiskId: null,
        floatingIpId: null,
        host: null,
        state: "failed",
        vmId: null,
      })
    );

    expect(await lifecycle.deleteBrowserVm(workspaceId, now)).toBe(true);

    expect(cloud.findCloudRuVmByName).toHaveBeenCalledOnce();
    expect(cloud.deleteCloudRuVm).not.toHaveBeenCalled();
    expect(rows.has(workspaceId)).toBe(false);
  });
});

describe("routing the VM's browser through a Russian exit", () => {
  it("leaves a fresh Russian exit alone", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow();
    rows.set(workspaceId, vm);

    expect(await lifecycle.prepareBrowserVmSession(vm, now)).toBe(vm);
    expect(worker.setBrowserVmWorkerProxy).not.toHaveBeenCalled();
  });

  it("rotates the sticky session until the exit is in Russia, and keeps that one", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ proxyExit: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ proxy: false })
    );
    worker.setBrowserVmWorkerProxy
      .mockResolvedValueOnce(proxySetup({ country: "DE", ip: "5.1.1.1" }))
      .mockResolvedValueOnce(proxySetup({ country: "RU", ip: "95.24.1.9" }));

    const prepared = await lifecycle.prepareBrowserVmSession(vm, now);

    const usernames = worker.setBrowserVmWorkerProxy.mock.calls.map(
      ([, proxy]) => proxy.username
    );
    expect(usernames).toHaveLength(2);
    expect(usernames[0]).toMatch(/^user-session-bro[\da-f]{12}$/u);
    expect(usernames[1]).toBe(`${usernames[0] ?? ""}r1`);
    expect(prepared.proxySession).toMatch(/^bro[\da-f]{12}r1$/u);
    expect(prepared.proxyExit).toEqual({
      at: now.toISOString(),
      city: "Somewhere",
      country: "RU",
      ip: "95.24.1.9",
      org: "AS1 Test",
    });
  });

  it("moves a slow Russian exit to the next rotation, and takes a slow one when none is left", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ proxyExit: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ proxy: false })
    );
    worker.setBrowserVmWorkerProxy
      .mockResolvedValueOnce(
        proxySetup({ country: "RU", ip: "95.24.1.1", mbps: 0.8 })
      )
      .mockResolvedValueOnce(
        proxySetup({ country: "RU", ip: "95.24.1.2", latencyMs: 4_000 })
      )
      .mockResolvedValueOnce(
        proxySetup({ country: "RU", ip: "95.24.1.3", latencyMs: 700, mbps: 6 })
      );

    const prepared = await lifecycle.prepareBrowserVmSession(vm, now);

    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledTimes(3);
    expect(prepared.proxyExit?.ip).toBe("95.24.1.3");

    // Every rotation slow: the last one is still better than no browser.
    worker.setBrowserVmWorkerProxy.mockClear();
    worker.setBrowserVmWorkerProxy.mockResolvedValue(
      proxySetup({ country: "RU", ip: "95.24.1.4", mbps: 1 })
    );
    rows.set(workspaceId, vmRow({ proxyExit: null }));
    const slow = await lifecycle.prepareBrowserVmSession(
      vmRow({ proxyExit: null }),
      now
    );

    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledTimes(4);
    expect(slow.proxyExit?.ip).toBe("95.24.1.4");
  });

  it("keeps a Russian exit whose speed could not be measured", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ proxyExit: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ proxy: false })
    );
    worker.setBrowserVmWorkerProxy.mockResolvedValue({
      ...proxySetup({ country: "RU", ip: "95.24.1.5", latencyMs: 700 }),
      exit: {
        country: "RU",
        error: "TimeoutError: ",
        ip: "95.24.1.5",
        latencyMs: 700,
        speedError: "TimeoutError: ",
      },
    });

    const prepared = await lifecycle.prepareBrowserVmSession(vm, now);

    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledOnce();
    expect(prepared.proxyExit).toMatchObject({
      country: "RU",
      ip: "95.24.1.5",
    });
  });

  it("refuses to start anything when no rotation gives a Russian exit", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({
      proxyExit: {
        at: minutesAgo(31).toISOString(),
        city: "Moscow",
        country: "RU",
        ip: "95.24.1.2",
        org: "AS8402 Beeline",
      },
    });
    rows.set(workspaceId, vm);
    worker.setBrowserVmWorkerProxy.mockResolvedValue(
      proxySetup({ country: "NL", ip: "5.2.2.2" })
    );

    const refused = await lifecycle
      .prepareBrowserVmSession(vm, now)
      .catch((cause: unknown) => cause);

    expect(refused).toMatchObject({
      name: "BrowserUseError",
      retryAfterMs: 5 * 60_000,
      status: 429,
    });
    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledTimes(4);
    expect(stored()).toMatchObject({ proxyExit: null });
    expect(stored().proxySession).toMatch(/^bro[\da-f]{12}r3$/u);
  });

  it("stops at the proxy's refusal of its login and tells the owner", async () => {
    // RU 01.10–02.10: every rotation failed within a second for a day, and
    // the reason was never logged.
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ proxyExit: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ proxy: false })
    );
    worker.setBrowserVmWorkerProxy.mockResolvedValue({
      ...proxySetup({ country: "RU", ip: "95.24.1.6" }),
      exit: {
        error:
          "ClientHttpProxyError: 407, message='Proxy Authentication Required', url='http://127.0.0.1:3128'",
      },
    });

    const refused = await lifecycle
      .prepareBrowserVmSession(vm, now)
      .catch((cause: unknown) => cause);

    expect(refused).toMatchObject({
      name: "BrowserUseError",
      retryAfterMs: 5 * 60_000,
      status: 429,
    });
    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledOnce();
    expect(stored()).toMatchObject({ proxyExit: null });
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      "browser-vm-proxy",
      expect.stringContaining(
        "ClientHttpProxyError: 407, message='Proxy Authentication Required'"
      ),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );
  });

  it("keeps the proxy's whole message for the owner, however it is quoted", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ proxyExit: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ proxy: false })
    );
    worker.setBrowserVmWorkerProxy.mockResolvedValue({
      ...proxySetup({ country: "RU", ip: "95.24.1.8" }),
      exit: {
        error:
          "ClientHttpProxyError: 402, message=\"user's traffic, it ran out\", url='http://127.0.0.1:3128'",
      },
    });

    await lifecycle.prepareBrowserVmSession(vm, now).catch(() => undefined);

    const text = alertOwner.mock.calls[0]?.[1] ?? "";
    expect(text).toContain(
      'ClientHttpProxyError: 402, message="user\'s traffic, it ran out"'
    );
    expect(text).not.toContain("127.0.0.1");
  });

  it("re-arms the proxy alert once the proxy takes the login again", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ proxyExit: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ proxy: false })
    );
    worker.setBrowserVmWorkerProxy.mockResolvedValue(
      proxySetup({ country: "RU", ip: "95.24.1.9" })
    );

    await lifecycle.prepareBrowserVmSession(vm, now);

    expect(clearOwnerAlert).toHaveBeenCalledWith("browser-vm-proxy", now);
  });

  it("goes on rotating when the worker could not reach the proxy", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ proxyExit: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ proxy: false })
    );
    worker.setBrowserVmWorkerProxy.mockResolvedValue({
      ...proxySetup({ country: "RU", ip: "95.24.1.7" }),
      exit: {
        error:
          "ClientHttpProxyError: 502, message='Bad Gateway', url='http://127.0.0.1:3128'",
      },
    });

    const refused = await lifecycle
      .prepareBrowserVmSession(vm, now)
      .catch((cause: unknown) => cause);

    expect(refused).toMatchObject({ name: "BrowserUseError", status: 429 });
    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledTimes(4);
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it("leaves the exit of a run going on the browser alone, however old its check", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ proxyExit: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(health({ busy: true }));

    expect(await lifecycle.prepareBrowserVmSession(vm, now)).toBe(vm);
    expect(worker.setBrowserVmWorkerProxy).not.toHaveBeenCalled();
  });

  it("sets a proxy the worker lost under a run again on the same session, never rotating it", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({ proxyExit: null, proxySession: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ busy: true, proxy: false })
    );
    worker.setBrowserVmWorkerProxy.mockResolvedValue(
      proxySetup({ country: "DE", ip: "5.1.1.1" })
    );

    const refused = await lifecycle
      .prepareBrowserVmSession(vm, now)
      .catch((cause: unknown) => cause);

    expect(refused).toMatchObject({ name: "BrowserUseError", status: 429 });
    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledOnce();
    expect(worker.setBrowserVmWorkerProxy.mock.calls[0]?.[1].username).toMatch(
      /^user-session-bro[\da-f]{12}$/u
    );
  });

  it("never moves the exit of a follow-up in an errand's session, however old its check", async () => {
    const lifecycle = await loadLifecycle();
    const { browserVmProxySession } =
      await import("@agent/lib/browser-vm/proxy");
    const session = browserVmProxySession(workspaceId, 2);
    const vm = vmRow({
      proxyExit: {
        at: minutesAgo(90).toISOString(),
        city: "Moscow",
        country: "RU",
        ip: "95.24.1.2",
        org: "AS8402 Beeline",
      },
      proxySession: session,
    });
    rows.set(workspaceId, vm);

    expect(
      await lifecycle.prepareBrowserVmSession(vm, now, { rotate: false })
    ).toBe(vm);
    expect(worker.setBrowserVmWorkerProxy).not.toHaveBeenCalled();

    // A worker that lost the proxy gets the same sticky session back, and
    // its Russian exit is kept however slow.
    worker.readBrowserVmWorkerHealth.mockResolvedValue(
      health({ proxy: false })
    );
    worker.setBrowserVmWorkerProxy.mockResolvedValue(
      proxySetup({ country: "RU", ip: "95.24.1.7", latencyMs: 4_000, mbps: 1 })
    );

    const prepared = await lifecycle.prepareBrowserVmSession(vm, now, {
      rotate: false,
    });

    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledOnce();
    expect(worker.setBrowserVmWorkerProxy.mock.calls[0]?.[1].username).toBe(
      `user-session-${session}`
    );
    expect(prepared).toMatchObject({
      proxyExit: { at: now.toISOString(), ip: "95.24.1.7" },
      proxySession: session,
    });

    // An exit outside Russia is refused rather than rotated.
    worker.setBrowserVmWorkerProxy.mockClear();
    worker.setBrowserVmWorkerProxy.mockResolvedValue(
      proxySetup({ country: "DE", ip: "5.1.1.1" })
    );
    const refused = await lifecycle
      .prepareBrowserVmSession(vm, now, { rotate: false })
      .catch((cause: unknown) => cause);

    expect(refused).toMatchObject({
      name: "BrowserUseError",
      retryAfterMs: 5 * 60_000,
      status: 429,
    });
    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledOnce();
    expect(stored().proxySession).toBe(session);
  });

  it("re-verifies a follow-up's stored session instead of trusting the worker when the last check never confirmed it", async () => {
    const lifecycle = await loadLifecycle();
    // The worker still reports a proxy set, but no check ever confirmed a
    // Russian exit (cleared by an earlier rotation that found none).
    const vm = vmRow({ proxyExit: null, proxySession: null });
    rows.set(workspaceId, vm);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(health({ proxy: true }));
    worker.setBrowserVmWorkerProxy.mockResolvedValue(
      proxySetup({ country: "RU", ip: "95.24.1.9" })
    );

    const prepared = await lifecycle.prepareBrowserVmSession(vm, now, {
      rotate: false,
    });

    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledOnce();
    expect(prepared.proxyExit).toMatchObject({ ip: "95.24.1.9" });
  });

  it("does not rotate a brand-new start while another errand still holds a kept page", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow({
      // Older than the check window: without a kept page this would rotate.
      proxyExit: {
        at: minutesAgo(45).toISOString(),
        city: "Moscow",
        country: "RU",
        ip: "95.24.1.2",
        org: "AS8402 Beeline",
      },
    });
    rows.set(workspaceId, vm);
    listWorkspacesHoldingBrowsers.mockResolvedValue([workspaceId]);

    const prepared = await lifecycle.prepareBrowserVmSession(vm, now);

    expect(prepared).toBe(vm);
    expect(worker.setBrowserVmWorkerProxy).not.toHaveBeenCalled();
    expect(listWorkspacesHoldingBrowsers).toHaveBeenCalledExactlyOnceWith(
      [workspaceId],
      now
    );
  });

  it("moves a fresh Russian exit to the next rotation on a freshExit retry", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow();
    rows.set(workspaceId, vm);
    worker.setBrowserVmWorkerProxy.mockResolvedValue(
      proxySetup({ country: "RU", ip: "95.24.1.20" })
    );

    const prepared = await lifecycle.prepareBrowserVmSession(vm, now, {
      freshExit: true,
    });

    expect(worker.setBrowserVmWorkerProxy).toHaveBeenCalledOnce();
    expect(worker.setBrowserVmWorkerProxy.mock.calls[0]?.[1].username).toMatch(
      /r1$/u
    );
    expect(prepared.proxyExit).toMatchObject({ ip: "95.24.1.20" });
  });

  it("does not move the exit on a freshExit retry while another errand still holds a kept page", async () => {
    const lifecycle = await loadLifecycle();
    const vm = vmRow();
    rows.set(workspaceId, vm);
    listWorkspacesHoldingBrowsers.mockResolvedValue([workspaceId]);

    const prepared = await lifecycle.prepareBrowserVmSession(vm, now, {
      freshExit: true,
    });

    expect(prepared).toBe(vm);
    expect(worker.setBrowserVmWorkerProxy).not.toHaveBeenCalled();
  });
});
