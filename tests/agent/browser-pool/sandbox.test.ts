import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as hostModule from "@agent/lib/browser-pool/host";
import type * as cloudRuModule from "@agent/lib/browser-vm/cloudru";
import type * as workerModule from "@agent/lib/browser-vm/worker";
import type * as ownerAlert from "@agent/lib/owner-alert";
import * as schema from "@db/schema";
import {
  browserPoolTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

const now = new Date("2026-09-30T12:00:00.000Z");
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);
const alice = { userId: "alice", workspaceId: "ws_alice" };
const bob = { userId: "bob", workspaceId: "ws_bob" };
const firstAddress = "45.132.176.117";
const secondAddress = "45.132.176.118";
/** `browserSandboxId("ws_alice")`: `ws-` and 40 hex of its SHA-256. */
const aliceSandbox = "ws-8bca567ef1568ecb0e07516230ad0a9d19700e02";

const hostClient = vi.hoisted(() => ({
  deleteBrowserHostSandbox: vi.fn<typeof hostModule.deleteBrowserHostSandbox>(),
  deleteBrowserSandbox: vi.fn<typeof hostModule.deleteBrowserSandbox>(),
  parkBrowserSandbox: vi.fn<typeof hostModule.parkBrowserSandbox>(),
  readBrowserHostCapacity: vi.fn<typeof hostModule.readBrowserHostCapacity>(),
  readBrowserHostHealth: vi.fn<typeof hostModule.readBrowserHostHealth>(),
  readBrowserSandbox: vi.fn<typeof hostModule.readBrowserSandbox>(),
  startBrowserSandbox: vi.fn<typeof hostModule.startBrowserSandbox>(),
}));
const worker = vi.hoisted(() => ({
  parkBrowserVmWorker: vi.fn<typeof workerModule.parkBrowserVmWorker>(),
  readBrowserVmWorkerHealth:
    vi.fn<typeof workerModule.readBrowserVmWorkerHealth>(),
  resetBrowserVmWorkerProfile:
    vi.fn<typeof workerModule.resetBrowserVmWorkerProfile>(),
}));
const cloud = vi.hoisted(() => ({
  createCloudRuHostVm: vi.fn<typeof cloudRuModule.createCloudRuHostVm>(),
  createCloudRuVm: vi.fn<typeof cloudRuModule.createCloudRuVm>(),
  deleteCloudRuFloatingIp:
    vi.fn<typeof cloudRuModule.deleteCloudRuFloatingIp>(),
  deleteCloudRuVm: vi.fn<typeof cloudRuModule.deleteCloudRuVm>(),
  findCloudRuVmByName: vi.fn<typeof cloudRuModule.findCloudRuVmByName>(),
  readCloudRuVm: vi.fn<typeof cloudRuModule.readCloudRuVm>(),
  setCloudRuVmPower: vi.fn<typeof cloudRuModule.setCloudRuVmPower>(),
}));
const alertOwner = vi.hoisted(() =>
  vi.fn<typeof ownerAlert.alertOwner>(() => Promise.resolve(true))
);

vi.mock("@agent/lib/browser-pool/host", async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  ...hostClient,
}));
vi.mock("@agent/lib/browser-vm/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof workerModule>()),
  ...worker,
}));
vi.mock("@agent/lib/browser-vm/cloudru", async (importOriginal) => ({
  ...(await importOriginal<typeof cloudRuModule>()),
  ...cloud,
}));
vi.mock("@agent/lib/owner-alert", () => ({ alertOwner }));

/** The pool's bucket as the stubbed Object Storage keeps it. */
const bucket = new Set<string>();
/** What a GET of an object of the bucket answers, by key. */
const contents = new Map<string, string>();
const databases: PGlite[] = [];

beforeEach(() => {
  bucket.clear();
  contents.clear();
  vi.stubGlobal("fetch", objectStorage);
  hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(0));
  hostClient.readBrowserHostHealth.mockResolvedValue({
    configured: true,
    hostd: "1",
    runsc: "runsc version release-20260914.0",
    stage: "ready",
  });
  hostClient.startBrowserSandbox.mockImplementation(async (_host, input) =>
    sandbox({ generation: input.generation, path: "fresh" })
  );
  hostClient.deleteBrowserSandbox.mockResolvedValue(true);
  hostClient.deleteBrowserHostSandbox.mockResolvedValue(true);
  worker.readBrowserVmWorkerHealth.mockResolvedValue(health());
  worker.parkBrowserVmWorker.mockResolvedValue(undefined);
  cloud.readCloudRuVm.mockImplementation(async (id) => ({
    bootDiskId: `disk-${id}`,
    floatingIpId: `fip-${id}`,
    host: id === "vm-host-2" ? secondAddress : firstAddress,
    id,
    state: "running",
  }));
  cloud.deleteCloudRuVm.mockResolvedValue(undefined);
  cloud.deleteCloudRuFloatingIp.mockResolvedValue(undefined);
  cloud.findCloudRuVmByName.mockResolvedValue(undefined);
  cloud.createCloudRuVm.mockResolvedValue({
    id: "vm-bob",
    image: "bro-browser-test-1",
    name: "bro-wsbob-1",
  });
});

afterEach(async () => {
  clearBrowserVmSettings();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

/**
 * Object Storage behind presigned URLs: a listing of the bucket by prefix
 * and deletions. Nothing else leaves the test.
 */
async function objectStorage(input: string | URL, init?: RequestInit) {
  const url = new URL(String(input));
  if (url.origin !== "https://s3.cloud.ru") {
    throw new Error(`Unexpected request to ${url.origin}`);
  }
  const key = decodeURIComponent(
    url.pathname.replace(/^\/bro-state-test\/?/u, "")
  );
  if (init?.method === "DELETE") {
    bucket.delete(key);
    return new Response(null, { status: 204 });
  }
  if (!url.searchParams.has("list-type")) {
    const content = contents.get(key);
    return content === undefined
      ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
      : new Response(content);
  }
  const prefix = url.searchParams.get("prefix") ?? "";
  const keys = [...bucket].filter((stored) => stored.startsWith(prefix));
  return new Response(
    `<ListBucketResult>${keys.map((stored) => `<Contents><Key>${stored}</Key></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`
  );
}

function capacity(
  committed: number,
  sandboxes: readonly Pick<Sandbox, "generation" | "id" | "state">[] = []
) {
  return {
    cpu: { features: "abc", model: "Intel" },
    disk: { freeMb: 30_000, totalMb: 40_000 },
    host: "bro-host-1",
    memoryMb: { available: 16_000 - committed, committed, total: 16_000 },
    rootfsVersions: ["2026-09-30.1"],
    runsc: "runsc version release-20260914.0",
    sandboxes: sandboxes.map((held) => ({
      generation: held.generation,
      id: held.id,
      memoryMb: 3072,
      state: held.state,
      usedMb: null,
    })),
    shm: { freeMb: 8000, totalMb: 8000 },
  };
}

type Sandbox = Awaited<ReturnType<typeof hostModule.startBrowserSandbox>>;

function sandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    error: null,
    fallback: null,
    generation: 1,
    id: aliceSandbox,
    memoryMb: 3072,
    path: "fresh",
    rootfsVersion: "2026-09-30.1",
    state: "running",
    workspace: alice.workspaceId,
    ...overrides,
  };
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
    image: null,
    proxy: true,
    stage: "ready",
    uptimeSeconds: 60,
    worker: "1",
    ...overrides,
  };
}

function parked(generation: number) {
  return {
    chunks: 4,
    format: { memoryMb: 3072, rootfs: "2026-09-30.1", runsc: "release-1" },
    generation,
    id: aliceSandbox,
    key: `sets/${aliceSandbox}/${String(generation)}/`,
    parts: {
      image: { bytes: 40, chunks: 3, plainBytes: 300 },
      profile: { bytes: 10, chunks: 1, plainBytes: 20 },
    },
    state: "parked" as const,
    timings: { totalMs: 2000 },
  };
}

async function loadPool(settings: Record<string, string> = {}) {
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const typed = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = typed as never;
  const costsOf = async () => typed.select().from(schema.usageCosts);
  return importWithSettings(
    {
      ...browserPoolTestEnvironment,
      BROWSER_POOL_WORKSPACES: alice.workspaceId,
      CLOUDRU_BROWSER_IMAGE: "bro-browser-test-1",
      ...settings,
    },
    async () => {
      const Database = await import("@db");
      vi.spyOn(Database, "db", "get").mockReturnValue(database);
      const scope = await import("@db/services/scope");
      const vms = await import("@db/services/browser-vms");
      const hosts = await import("@db/services/browser-hosts");
      const lifecycle = await import("@agent/lib/browser-vm/lifecycle");
      const runs = await import("@agent/lib/browser-vm/runs");
      await scope.ensureScope(alice);
      await scope.ensureScope(bob);
      return { costsOf, hosts, lifecycle, runs, vms };
    }
  );
}

type Pool = Awaited<ReturnType<typeof loadPool>>;

/** A ready host in `slot`, as the host watchdog would leave it. */
async function seedHost(
  pool: Pool,
  slot: 1 | 2,
  patch: Parameters<Pool["hosts"]["updateBrowserHost"]>[1] = {}
) {
  const id = `bro-host-${String(slot)}`;
  const claimed = await pool.hosts.claimBrowserHostSlot(slot, minutes(-120), 1);
  if (claimed?.id !== id) throw new Error(`Seeded ${String(claimed?.id)}.`);
  await pool.hosts.releaseBrowserHostLease(id);
  return pool.hosts.updateBrowserHost(
    id,
    {
      address: slot === 1 ? firstAddress : secondAddress,
      capacity: {
        committedMb: 0,
        limitMb: 14_976,
        rootfsVersions: ["2026-09-30.1"],
        runsc: "runsc version release-20260914.0",
        sandboxes: 1,
      },
      floatingIpId: `fip-vm-host-${String(slot)}`,
      lastSeenAt: minutes(-1),
      state: "ready",
      vmId: `vm-host-${String(slot)}`,
      ...patch,
    },
    minutes(-120)
  );
}

/** Alice's record as a pool record in `patch`'s state. */
/**
 * Alice's record. A set in it carries a runsc snapshot format unless the
 * patch says otherwise (null: a runc set, the profile alone).
 */
async function seedAlice(
  pool: Pool,
  patch: Parameters<Pool["vms"]["updateBrowserVm"]>[1]
) {
  await pool.vms.ensureBrowserVmRecord(alice.workspaceId);
  const format =
    patch.snapshotKey !== undefined &&
    patch.snapshotKey !== null &&
    !("snapshotFormat" in patch)
      ? { snapshotFormat: JSON.stringify(parked(0).format) }
      : {};
  return pool.vms.updateBrowserVm(
    alice.workspaceId,
    { ...format, ...patch },
    minutes(-60)
  );
}

/** A running sandbox of Alice's on host one, used `idleMinutes` ago. */
async function seedRunning(
  pool: Pool,
  idleMinutes: number,
  patch: Parameters<Pool["vms"]["updateBrowserVm"]>[1] = {}
) {
  await seedHost(pool, 1);
  return seedAlice(pool, {
    generation: 3,
    host: firstAddress,
    hostId: "bro-host-1",
    lastUsedAt: minutes(-idleMinutes),
    poweredOnAt: minutes(-idleMinutes - 5),
    sandboxState: "running",
    snapshotChunks: 4,
    snapshotGeneration: 2,
    snapshotKey: `sets/${aliceSandbox}/2/`,
    state: "ready",
    ...patch,
  });
}

function hostErrorBody(
  status: number,
  body: Readonly<Record<string, boolean | number | string>>
) {
  return async () => {
    const { BrowserHostError } = await import("@agent/lib/browser-pool/host");
    throw new BrowserHostError(status, "/v1/sandboxes", JSON.stringify(body));
  };
}

describe("bringing a pool workspace's sandbox up", { timeout: 60_000 }, () => {
  it("starts a fresh sandbox for a workspace with none, writing its host first", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    hostClient.startBrowserSandbox.mockImplementation(async (_host, input) => {
      // The host is on record before hostd is asked, so the host watchdog
      // does not take it for empty and delete it under the start.
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        generation: 1,
        hostId: "bro-host-1",
        sandboxState: "starting",
        state: "starting",
      });
      return sandbox({ generation: input.generation });
    });

    const started = await pool.lifecycle.ensureBrowserVm(
      alice.workspaceId,
      now
    );

    expect(started).toMatchObject({
      kind: "ready",
      vm: {
        generation: 1,
        host: firstAddress,
        hostId: "bro-host-1",
        sandboxState: "running",
        state: "ready",
        vmId: null,
      },
    });
    expect(hostClient.startBrowserSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bro-host-1" }),
      { from: undefined, generation: 1, workspaceId: alice.workspaceId }
    );
    // No VM of its own is created for it.
    expect(cloud.createCloudRuVm).not.toHaveBeenCalled();
  });

  it("restores a parked sandbox from its set under the next generation", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedAlice(pool, {
      generation: 3,
      sandboxState: "parked",
      snapshotChunks: 5,
      snapshotGeneration: 3,
      snapshotKey: `sets/${aliceSandbox}/3/`,
    });
    hostClient.startBrowserSandbox.mockImplementation(async (_host, input) =>
      sandbox({ generation: input.generation, path: "restored" })
    );

    const started = await pool.lifecycle.ensureBrowserVm(
      alice.workspaceId,
      now
    );

    expect(started).toMatchObject({
      kind: "ready",
      vm: { generation: 4, sandboxState: "running" },
    });
    expect(hostClient.startBrowserSandbox).toHaveBeenCalledWith(
      expect.anything(),
      {
        from: { chunks: 5, key: `sets/${aliceSandbox}/3/`, snapshot: true },
        generation: 4,
        workspaceId: alice.workspaceId,
      }
    );
  });

  it("starts a cold sandbox from the profile of its set alone", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedAlice(pool, {
      generation: 2,
      sandboxState: "cold",
      snapshotChunks: 3,
      snapshotGeneration: 2,
      snapshotKey: `sets/${aliceSandbox}/2/`,
    });

    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now);

    expect(hostClient.startBrowserSandbox).toHaveBeenCalledWith(
      expect.anything(),
      {
        from: { chunks: 3, key: `sets/${aliceSandbox}/2/`, snapshot: false },
        generation: 3,
        workspaceId: alice.workspaceId,
      }
    );
  });

  it("falls back to the profile alone when the set's snapshot did not come up", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedAlice(pool, {
      generation: 3,
      sandboxState: "parked",
      snapshotChunks: 5,
      snapshotGeneration: 3,
      snapshotKey: `sets/${aliceSandbox}/3/`,
    });
    hostClient.startBrowserSandbox.mockImplementationOnce(
      hostErrorBody(502, {
        error:
          "sandbox did not start: chunk 2 of image does not decrypt: tampered, reordered or from another set",
      })
    );

    expect(
      await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
    ).toEqual({ kind: "starting", retryAfterMs: 15_000 });
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      host: null,
      hostId: null,
      sandboxState: "cold",
      state: "stopped",
    });

    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, minutes(1));
    expect(hostClient.startBrowserSandbox).toHaveBeenLastCalledWith(
      expect.anything(),
      {
        from: { chunks: 5, key: `sets/${aliceSandbox}/3/`, snapshot: false },
        generation: 5,
        workspaceId: alice.workspaceId,
      }
    );
  });

  it("keeps the set when the host, not the set, failed the start", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedAlice(pool, {
      generation: 3,
      sandboxState: "parked",
      snapshotChunks: 5,
      snapshotGeneration: 3,
      snapshotKey: `sets/${aliceSandbox}/3/`,
    });
    // hostd restarting behind Caddy, then runsc failing: twice in a row.
    hostClient.startBrowserSandbox
      .mockImplementationOnce(hostErrorBody(502, { error: "bad gateway" }))
      .mockImplementationOnce(
        hostErrorBody(502, {
          error: "sandbox did not start: runsc create failed (see run.log)",
        })
      );

    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now);
    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, minutes(1));

    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      hostId: null,
      sandboxState: "parked",
      snapshotChunks: 5,
      snapshotKey: `sets/${aliceSandbox}/3/`,
      state: "stopped",
    });
    expect(alertOwner).toHaveBeenCalledWith(
      `browser-sandbox-host:${alice.workspaceId}`,
      expect.stringContaining("runsc create failed"),
      expect.anything()
    );

    // The third errand restores the snapshot of the same set.
    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, minutes(2));
    expect(hostClient.startBrowserSandbox).toHaveBeenLastCalledWith(
      expect.anything(),
      {
        from: { chunks: 5, key: `sets/${aliceSandbox}/3/`, snapshot: true },
        generation: 6,
        workspaceId: alice.workspaceId,
      }
    );
  });

  it("goes past a set the host finds not older than the start", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedAlice(pool, {
      generation: 3,
      sandboxState: "parked",
      snapshotChunks: 5,
      snapshotGeneration: 3,
      snapshotKey: `sets/${aliceSandbox}/3/`,
    });
    hostClient.startBrowserSandbox.mockImplementationOnce(
      hostErrorBody(409, {
        error: "the set is not older than this generation",
        setGeneration: 9,
      })
    );

    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now);
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      generation: 9,
      sandboxState: "parked",
      snapshotKey: `sets/${aliceSandbox}/3/`,
    });

    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, minutes(1));
    expect(hostClient.startBrowserSandbox).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ generation: 10 })
    );
  });

  it("waits while Cloud.ru no longer has the host's VM at its address", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 1);
    cloud.readCloudRuVm.mockResolvedValue({
      bootDiskId: "disk-other",
      floatingIpId: "fip-other",
      host: "45.132.176.250",
      id: "vm-host-1",
      state: "running",
    });

    expect(
      await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
    ).toMatchObject({ kind: "starting" });
    expect(worker.readBrowserVmWorkerHealth).not.toHaveBeenCalled();
  });

  it("goes past a newer generation the host knows of the sandbox", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    hostClient.startBrowserSandbox.mockImplementationOnce(
      hostErrorBody(409, { error: "stale generation", generation: 7 })
    );

    expect(
      await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
    ).toMatchObject({ kind: "starting" });
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      generation: 7,
      sandboxState: "absent",
      state: "stopped",
    });

    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, minutes(1));
    expect(hostClient.startBrowserSandbox).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ generation: 8 })
    );
  });

  it("leaves a start whose answer was lost for the reconcile to read back", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    hostClient.startBrowserSandbox.mockRejectedValueOnce(
      new Error("The operation was aborted due to timeout")
    );

    expect(
      await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
    ).toEqual({ kind: "starting", retryAfterMs: 30_000 });
    // A second errand meanwhile reads the start back and, while it is
    // still going, does not start it again.
    hostClient.readBrowserSandbox.mockResolvedValue(
      sandbox({ generation: 1, state: "starting" })
    );
    expect(
      await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
    ).toMatchObject({ kind: "starting" });
    expect(hostClient.startBrowserSandbox).toHaveBeenCalledOnce();

    hostClient.readBrowserSandbox.mockResolvedValue(sandbox({ generation: 1 }));
    await pool.lifecycle.reconcileBrowserVms(minutes(1));

    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      sandboxState: "running",
      state: "ready",
    });
    expect(hostClient.startBrowserSandbox).toHaveBeenCalledOnce();
  });

  it("has an errand read back a start whose step is gone, and take the sandbox", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    hostClient.startBrowserSandbox.mockRejectedValueOnce(
      new Error("The operation was aborted due to timeout")
    );
    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now);

    hostClient.readBrowserSandbox.mockResolvedValue(sandbox({ generation: 1 }));
    expect(
      await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
    ).toMatchObject({ kind: "ready", vm: { sandboxState: "running" } });
    expect(hostClient.startBrowserSandbox).toHaveBeenCalledOnce();
  });

  it("leaves a workspace outside the pool on its own VM, untouched", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);

    const started = await pool.lifecycle.ensureBrowserVm(bob.workspaceId, now);

    expect(started).toEqual({ kind: "starting", retryAfterMs: 180_000 });
    expect(cloud.createCloudRuVm).toHaveBeenCalledOnce();
    expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
    expect(await pool.vms.readBrowserVm(bob.workspaceId)).toMatchObject({
      hostId: null,
      sandboxState: null,
      state: "creating",
      vmId: "vm-bob",
    });
  });

  it("keeps a listed workspace that already has a VM on that VM", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedAlice(pool, { state: "stopped", vmId: "vm-alice" });
    cloud.readCloudRuVm.mockResolvedValue({
      bootDiskId: "disk-alice",
      floatingIpId: "fip-alice",
      host: "45.132.176.9",
      id: "vm-alice",
      state: "stopped",
    });
    cloud.setCloudRuVmPower.mockResolvedValue(undefined);

    await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now);

    expect(cloud.setCloudRuVmPower).toHaveBeenCalledWith(
      "vm-alice",
      "power_on"
    );
    expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
  });
});

describe("runs on a sandbox", { timeout: 60_000 }, () => {
  it("keeps a run open while the worker of its running sandbox does not answer", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 1);
    const runId = `vm:${alice.workspaceId}:r:1`;
    await pool.vms.recordBrowserVmRun({
      id: runId,
      sessionId: `vm:${alice.workspaceId}:s:1`,
      status: "running",
      task: "Find a table",
      workspaceId: alice.workspaceId,
    });
    // The stubbed network answers Object Storage alone: the worker is silent.

    expect(await pool.runs.readBrowserVmRun(runId)).toMatchObject({
      status: "running",
    });
    // A cancel that did not reach the worker is not taken as a stop.
    await expect(pool.runs.cancelBrowserVmRun(runId)).rejects.toThrow(
      "Unexpected request to https://45-132-176-117.sslip.io"
    );
  });

  it("closes a run left open on a sandbox that is on no host", async () => {
    const pool = await loadPool();
    await seedAlice(pool, {
      generation: 3,
      sandboxState: "parked",
      snapshotChunks: 4,
      snapshotGeneration: 3,
      snapshotKey: `sets/${aliceSandbox}/3/`,
    });
    const runId = `vm:${alice.workspaceId}:r:1`;
    await pool.vms.recordBrowserVmRun({
      id: runId,
      sessionId: `vm:${alice.workspaceId}:s:1`,
      status: "running",
      task: "Find a table",
      workspaceId: alice.workspaceId,
    });

    expect(await pool.runs.readBrowserVmRun(runId)).toMatchObject({
      status: "failed",
    });
  });
});

describe("parking an idle sandbox", { timeout: 60_000 }, () => {
  it("parks a sandbox past its idle window into a new set, and prunes the old", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 30);
    bucket.add(`sets/${aliceSandbox}/2/chunk-0000`);
    bucket.add(`sets/${aliceSandbox}/2/manifest.json`);
    bucket.add(`sets/${aliceSandbox}/3/chunk-0000`);
    bucket.add(`sets/${aliceSandbox}/3/manifest.json`);
    hostClient.parkBrowserSandbox.mockResolvedValue(parked(3));

    await pool.lifecycle.reconcileBrowserVms(now);

    // A host of a runsc-only hostd (no runtime reported) freezes Chrome as is.
    expect(worker.parkBrowserVmWorker).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: alice.workspaceId }),
      { closeChrome: false }
    );
    expect(hostClient.parkBrowserSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bro-host-1" }),
      { ample: false, generation: 3, workspaceId: alice.workspaceId }
    );
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      host: null,
      hostId: null,
      poweredOnAt: null,
      sandboxState: "parked",
      snapshotChunks: 4,
      snapshotGeneration: 3,
      snapshotKey: `sets/${aliceSandbox}/3/`,
      state: "stopped",
    });
    expect([...bucket].toSorted()).toEqual([
      `sets/${aliceSandbox}/3/chunk-0000`,
      `sets/${aliceSandbox}/3/manifest.json`,
    ]);
    // The 35 minutes it lived on the host are charged at its share of it.
    const [cost] = await pool.costsOf();
    expect(cost).toMatchObject({
      idempotencyKey: `browser-sandbox:${alice.workspaceId}:${minutes(-35).toISOString()}`,
      source: "browser-vm",
      units: { flavor: "gen-4-16", seconds: 2100 },
    });
  });

  it("records a runc park without a snapshot, and starts it again from its profile", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 30);
    await pool.hosts.updateBrowserHost(
      "bro-host-1",
      {
        capacity: {
          committedMb: 3072,
          limitMb: 14_976,
          rootfsVersions: ["2026-09-30.1"],
          runsc: null,
          runtime: "runc",
          sandboxes: 1,
        },
      },
      minutes(-2)
    );
    hostClient.parkBrowserSandbox.mockResolvedValue({
      ...parked(3),
      format: null,
      parts: { profile: { bytes: 10, chunks: 4, plainBytes: 20 } },
    });

    await pool.lifecycle.reconcileBrowserVms(now);
    // runc stops Chrome with SIGTERM, which writes no cookies: the worker
    // closes Chrome first.
    expect(worker.parkBrowserVmWorker).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: alice.workspaceId }),
      { closeChrome: true }
    );
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      sandboxState: "parked",
      snapshotFormat: null,
      snapshotKey: `sets/${aliceSandbox}/3/`,
    });

    hostClient.startBrowserSandbox.mockImplementation(async (_host, input) =>
      sandbox({ generation: input.generation, path: "cold" })
    );
    expect(
      await pool.lifecycle.ensureBrowserVm(alice.workspaceId, minutes(1))
    ).toMatchObject({ kind: "ready", vm: { lastError: null } });
    // As `profile`, which runc takes as is, not as a `restore` it falls back from.
    expect(hostClient.startBrowserSandbox).toHaveBeenCalledWith(
      expect.anything(),
      {
        from: { chunks: 4, key: `sets/${aliceSandbox}/3/`, snapshot: false },
        generation: 4,
        workspaceId: alice.workspaceId,
      }
    );
  });

  it("does not park a sandbox used within its idle window", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 1);

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(worker.parkBrowserVmWorker).not.toHaveBeenCalled();
    expect(hostClient.parkBrowserSandbox).not.toHaveBeenCalled();
  });

  it("never parks a sandbox while a run is open on it", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 30);
    await pool.vms.recordBrowserVmRun({
      id: `vm:${alice.workspaceId}:r:1`,
      sessionId: `vm:${alice.workspaceId}:s:1`,
      status: "running",
      task: "Find a table",
      workspaceId: alice.workspaceId,
    });

    await pool.lifecycle.reconcileBrowserVms(now);
    expect(hostClient.parkBrowserSandbox).not.toHaveBeenCalled();
  });

  it("never parks while the worker is busy with a run", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 30);
    worker.readBrowserVmWorkerHealth.mockResolvedValue(health({ busy: true }));

    await pool.lifecycle.reconcileBrowserVms(now);
    expect(worker.parkBrowserVmWorker).not.toHaveBeenCalled();
    expect(hostClient.parkBrowserSandbox).not.toHaveBeenCalled();
  });

  it("keeps the sandbox running when the worker refuses to park under a run", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 30);
    const { BrowserVmWorkerError } =
      await import("@agent/lib/browser-vm/worker");
    worker.parkBrowserVmWorker.mockRejectedValue(
      new BrowserVmWorkerError(409, "/v1/park", '{"error": "busy"}')
    );

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(hostClient.parkBrowserSandbox).not.toHaveBeenCalled();
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      hostId: "bro-host-1",
      sandboxState: "running",
      state: "ready",
    });
  });

  it("keeps a sandbox whose park failed running on its host, to try again", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 30);
    hostClient.parkBrowserSandbox.mockImplementation(
      hostErrorBody(502, {
        error: "the set was not written",
        restoredLocally: true,
      })
    );
    hostClient.readBrowserSandbox.mockResolvedValue(sandbox({ generation: 3 }));

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      hostId: "bro-host-1",
      parkFailures: 1,
      parkRetryAt: minutes(10),
      sandboxState: "running",
      snapshotKey: `sets/${aliceSandbox}/2/`,
      state: "ready",
    });

    // Not every minute: the next park waits ten minutes, the ones after it
    // an hour, and goes with every chunk URL hostd takes.
    await pool.lifecycle.reconcileBrowserVms(minutes(5));
    expect(hostClient.parkBrowserSandbox).toHaveBeenCalledOnce();
    await pool.lifecycle.reconcileBrowserVms(minutes(11));
    expect(hostClient.parkBrowserSandbox).toHaveBeenCalledTimes(2);
    expect(hostClient.parkBrowserSandbox).toHaveBeenLastCalledWith(
      expect.anything(),
      { ample: true, generation: 3, workspaceId: alice.workspaceId }
    );
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      parkFailures: 2,
      parkRetryAt: minutes(71),
    });
    expect(alertOwner).not.toHaveBeenCalled();

    await pool.lifecycle.reconcileBrowserVms(minutes(72));
    expect(alertOwner).toHaveBeenCalledWith(
      `browser-sandbox-park:${alice.workspaceId}`,
      expect.stringContaining("3 раз подряд"),
      expect.anything()
    );
  });

  it("records the set of a park whose sandbox hostd could not delete", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 30);
    bucket.add(`sets/${aliceSandbox}/2/manifest.json`);
    bucket.add(`sets/${aliceSandbox}/3/manifest.json`);
    contents.set(
      `sets/${aliceSandbox}/3/manifest.json`,
      JSON.stringify({
        format: 1,
        generation: 3,
        mac: "ff",
        parts: [
          { chunks: [{}, {}, {}], name: "image" },
          { chunks: [{}], name: "profile" },
        ],
        snapshot: { memoryMb: 3072, rootfs: "2026-09-30.1" },
        workspace: alice.workspaceId,
      })
    );
    hostClient.parkBrowserSandbox.mockImplementation(
      hostErrorBody(502, {
        error: "the set is written but runsc could not delete the sandbox",
        setWritten: true,
      })
    );

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      hostId: null,
      sandboxState: "parked",
      snapshotChunks: 4,
      snapshotGeneration: 3,
      snapshotKey: `sets/${aliceSandbox}/3/`,
      state: "stopped",
    });
    expect([...bucket]).toEqual([`sets/${aliceSandbox}/3/manifest.json`]);
  });

  it("takes an idle sandbox off its host when its sets cannot be written", async () => {
    const pool = await loadPool({ BROWSER_STATE_KEY: "" });
    await seedRunning(pool, 30);

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(hostClient.parkBrowserSandbox).not.toHaveBeenCalled();
    expect(hostClient.deleteBrowserSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bro-host-1" }),
      { generation: 3, workspaceId: alice.workspaceId }
    );
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      hostId: null,
      sandboxState: "parked",
      snapshotKey: `sets/${aliceSandbox}/2/`,
    });
    expect(alertOwner).toHaveBeenCalledWith(
      `browser-sandbox-unparked:${alice.workspaceId}`,
      expect.stringContaining("BROWSER_STATE_KEY"),
      expect.anything()
    );
  });

  it("records a park whose answer was lost once the host says it parked", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 30);
    hostClient.parkBrowserSandbox.mockRejectedValue(
      new Error("The operation was aborted due to timeout")
    );

    await pool.lifecycle.reconcileBrowserVms(now);
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      sandboxState: "parking",
      state: "stopping",
    });

    hostClient.readBrowserSandbox.mockResolvedValue(
      sandbox({ generation: 3, parked: parked(3), state: "parked" })
    );
    await pool.lifecycle.reconcileBrowserVms(minutes(7));

    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      hostId: null,
      sandboxState: "parked",
      snapshotGeneration: 3,
      snapshotKey: `sets/${aliceSandbox}/3/`,
      state: "stopped",
    });
  });
});

describe("a pool turned off with hosts left", { timeout: 60_000 }, () => {
  it("still looks after the hosts, which bill until deleted", async () => {
    const pool = await loadPool({ BROWSER_HOST_BUNDLE: "" });
    await seedHost(pool, 1, { emptySince: minutes(-61) });

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(await pool.hosts.readBrowserHost("bro-host-1")).toMatchObject({
      state: "draining",
    });
  });

  it("asks nothing of the pool once it is off and no host is left", async () => {
    const pool = await loadPool({ BROWSER_HOST_BUNDLE: "" });

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(hostClient.readBrowserHostCapacity).not.toHaveBeenCalled();
    expect(cloud.readCloudRuVm).not.toHaveBeenCalled();
  });
});

describe("a host that fails", { timeout: 60_000 }, () => {
  it("takes its sandboxes back to their sets and restores them on another host", async () => {
    const pool = await loadPool({ BROWSER_HOST_MAX: "2" });
    await seedRunning(pool, 1);
    await pool.hosts.updateBrowserHost(
      "bro-host-1",
      { lastError: "hostd stopped answering", state: "failed" },
      minutes(-1)
    );

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      host: null,
      hostId: null,
      sandboxState: "parked",
      snapshotKey: `sets/${aliceSandbox}/2/`,
      state: "stopped",
    });
    // The failed host goes once nothing is placed on it any more.
    await pool.lifecycle.reconcileBrowserVms(minutes(1));
    expect(cloud.deleteCloudRuVm).toHaveBeenCalledWith("vm-host-1", {
      diskIds: [],
      floatingIpIds: ["fip-vm-host-1"],
    });

    await seedHost(pool, 2);
    hostClient.startBrowserSandbox.mockImplementation(async (_host, input) =>
      sandbox({ generation: input.generation, path: "restored" })
    );
    const started = await pool.lifecycle.ensureBrowserVm(
      alice.workspaceId,
      minutes(2)
    );

    expect(started).toMatchObject({
      kind: "ready",
      vm: { generation: 4, host: secondAddress, hostId: "bro-host-2" },
    });
    expect(hostClient.startBrowserSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bro-host-2" }),
      {
        from: { chunks: 4, key: `sets/${aliceSandbox}/2/`, snapshot: true },
        generation: 4,
        workspaceId: alice.workspaceId,
      }
    );
  });

  it("sends nothing to the address of a host that failed", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 1);
    await pool.hosts.updateBrowserHost(
      "bro-host-1",
      { state: "failed" },
      minutes(-1)
    );

    expect(
      await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
    ).toMatchObject({ kind: "starting" });
    expect(worker.readBrowserVmWorkerHealth).not.toHaveBeenCalled();
  });

  it("clears away a sandbox a host holds that no record places there", async () => {
    const pool = await loadPool();
    await seedRunning(pool, 1);
    hostClient.readBrowserHostCapacity.mockResolvedValue(
      capacity(6144, [
        { generation: 3, id: aliceSandbox, state: "running" },
        { generation: 2, id: "ws-left-over", state: "running" },
        { generation: 1, id: "ws-parked", state: "parked" },
      ])
    );

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(hostClient.deleteBrowserHostSandbox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "bro-host-1" }),
      { generation: 2, id: "ws-left-over" }
    );
  });
});

describe(
  "forgetting and deleting a pool workspace's browser",
  { timeout: 60_000 },
  () => {
    it("deletes the sets of a profile forgotten while the sandbox was parked", async () => {
      const pool = await loadPool();
      await seedAlice(pool, {
        generation: 3,
        profileResetPending: true,
        sandboxState: "parked",
        snapshotChunks: 4,
        snapshotGeneration: 3,
        snapshotKey: `sets/${aliceSandbox}/3/`,
      });
      bucket.add(`sets/${aliceSandbox}/3/chunk-0000`);
      bucket.add(`sets/${aliceSandbox}/3/manifest.json`);

      await pool.lifecycle.reconcileBrowserVms(now);

      expect(bucket.size).toBe(0);
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        profileResetPending: false,
        sandboxState: "absent",
        snapshotKey: null,
      });
    });

    it("deletes the sandbox on its host and every set in Object Storage", async () => {
      const pool = await loadPool();
      await seedRunning(pool, 1);
      bucket.add(`sets/${aliceSandbox}/2/chunk-0000`);
      bucket.add(`sets/${aliceSandbox}/2/manifest.json`);
      bucket.add("sets/ws-someone-else/1/manifest.json");

      expect(await pool.lifecycle.deleteBrowserVm(alice.workspaceId, now)).toBe(
        true
      );

      expect(hostClient.deleteBrowserSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ id: "bro-host-1" }),
        { generation: 3, workspaceId: alice.workspaceId }
      );
      expect([...bucket]).toEqual(["sets/ws-someone-else/1/manifest.json"]);
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toBeUndefined();
    });

    it("keeps the record deleting when the host cannot be asked, and finishes later", async () => {
      const pool = await loadPool();
      await seedRunning(pool, 1);
      hostClient.deleteBrowserSandbox.mockRejectedValueOnce(
        new Error("fetch failed")
      );

      await expect(
        pool.lifecycle.deleteBrowserVm(alice.workspaceId, now)
      ).rejects.toThrow("fetch failed");
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        state: "deleting",
      });

      await pool.lifecycle.reconcileBrowserVms(minutes(1));
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toBeUndefined();
    });
  }
);

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../../db/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}
