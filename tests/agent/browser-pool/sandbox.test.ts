import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
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

function unusedFileSandboxIo(): never {
  throw new Error("Owned shared files need no sandbox I/O");
}

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
  updateBrowserVmWorkerCode:
    vi.fn<typeof workerModule.updateBrowserVmWorkerCode>(),
}));
const cloud = vi.hoisted(() => ({
  createCloudRuHostVm: vi.fn<typeof cloudRuModule.createCloudRuHostVm>(),
  createCloudRuVm: vi.fn<typeof cloudRuModule.createCloudRuVm>(),
  deleteCloudRuBackupsOf: vi.fn<typeof cloudRuModule.deleteCloudRuBackupsOf>(),
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
vi.mock("@agent/lib/owner-alert", () => ({
  alertOwner,
  clearOwnerAlert: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

/** The pool's bucket as the stubbed Object Storage keeps it. */
const bucket = new Set<string>();
/** What a GET of an object of the bucket answers, by key. */
const contents = new Map<string, string>();
const databases: PGlite[] = [];

beforeEach(() => {
  vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", "");
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
  cloud.deleteCloudRuBackupsOf.mockResolvedValue(0);
  cloud.findCloudRuVmByName.mockResolvedValue(undefined);
  cloud.createCloudRuVm.mockResolvedValue({
    id: "vm-bob",
    image: "bro-browser-test-1",
    name: "bro-wsbob-1",
  });
});

afterEach(async () => {
  vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", "");
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
  /**
   * The next `count` writes of a VM's time fail, as a `usage_costs` outage
   * would: a sequence, since it counts outside the failed transactions.
   */
  const failVmUptimeWrites = async (count: number) =>
    client.exec(`
      CREATE SEQUENCE vm_uptime_failures;
      CREATE FUNCTION fail_vm_uptime() RETURNS trigger AS $$
      BEGIN
        IF NEW.source = 'browser-vm' AND nextval('vm_uptime_failures') <= ${String(count)} THEN
          RAISE EXCEPTION 'usage_costs is down';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_vm_uptime BEFORE INSERT ON usage_costs
        FOR EACH ROW EXECUTE FUNCTION fail_vm_uptime();
    `);
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
      const idle = await import("@agent/lib/browser-vm/idle");
      const sandboxes = await import("@agent/lib/browser-pool/sandbox");
      await scope.ensureScope(alice);
      await scope.ensureScope(bob);
      return {
        costsOf,
        failVmUptimeWrites,
        hosts,
        idle,
        lifecycle,
        runs,
        sandboxes,
        vms,
      };
    }
  );
}

type Pool = Awaited<ReturnType<typeof loadPool>>;

describe("files-pilot pool worker rollout", { timeout: 60_000 }, () => {
  const code = 'VERSION = "2026-10-06.3"\n';
  const checksum = createHash("sha256").update(code).digest("hex");
  const published = `2026-10-06.3:workers/files.py:${checksum}`;

  it("upgrades under the start lease before handout and again after a profile-only wake", async () => {
    vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", alice.workspaceId);
    const pool = await loadPool({ BROWSER_VM_WORKER: published });
    await seedHost(pool, 1);
    await seedAlice(pool, { sandboxState: "parked", state: "stopped" });
    contents.set("workers/files.py", code);
    worker.updateBrowserVmWorkerCode.mockImplementation(async (vm) => {
      const current = await pool.vms.readBrowserVm(alice.workspaceId);
      expect(current?.leaseUntil).toBeInstanceOf(Date);
      expect(current?.sandboxState).toBe("running");
      expect(current?.workerRolloutAt).toBeInstanceOf(Date);
      expect(current?.generation).toBe(vm.generation);
      worker.readBrowserVmWorkerHealth.mockResolvedValue(
        health({ worker: "2026-10-06.3" })
      );
    });

    await pool.sandboxes.prewarmBrowserSandbox(alice.workspaceId, now);
    expect(worker.updateBrowserVmWorkerCode).toHaveBeenCalledOnce();
    const warmed = await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now);
    expect(warmed.kind).toBe("ready");
    expect(worker.updateBrowserVmWorkerCode).toHaveBeenCalledOnce();

    await pool.vms.updateBrowserVm(alice.workspaceId, {
      host: null,
      hostId: null,
      sandboxState: "parked",
      state: "stopped",
    });
    worker.readBrowserVmWorkerHealth.mockResolvedValue(health());
    const woken = await pool.lifecycle.ensureBrowserVm(
      alice.workspaceId,
      minutes(1)
    );
    expect(woken.kind).toBe("ready");
    expect(worker.updateBrowserVmWorkerCode).toHaveBeenCalledTimes(2);
    expect(worker.updateBrowserVmWorkerCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 2 }),
      new TextEncoder().encode(code),
      checksum,
      expect.any(Number)
    );
    expect(
      (await pool.vms.readBrowserVm(alice.workspaceId))?.leaseUntil
    ).toBeNull();
  });

  it("leaves flag-off, recently handed-out and busy sandboxes on their existing worker", async () => {
    const pool = await loadPool({ BROWSER_VM_WORKER: published });
    await seedRunning(pool, 10);
    expect(
      (await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)).kind
    ).toBe("ready");
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();

    vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", alice.workspaceId);
    const pilot = await loadPool({ BROWSER_VM_WORKER: published });
    await seedRunning(pilot, 0);
    contents.set("workers/files.py", code);
    expect(
      (await pilot.lifecycle.ensureBrowserVm(alice.workspaceId, now)).kind
    ).toBe("ready");
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();

    await pilot.vms.updateBrowserVm(alice.workspaceId, {
      lastUsedAt: minutes(-10),
    });
    worker.readBrowserVmWorkerHealth.mockResolvedValue(health({ busy: true }));
    expect(
      (await pilot.lifecycle.ensureBrowserVm(alice.workspaceId, now)).kind
    ).toBe("ready");
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });

  it("does not restart an idle worker with an open run", async () => {
    vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", alice.workspaceId);
    const pool = await loadPool({ BROWSER_VM_WORKER: published });
    await seedRunning(pool, 10);
    await pool.vms.recordBrowserVmRun({
      id: `vm:${alice.workspaceId}:r:open`,
      sessionId: `vm:${alice.workspaceId}:s:open`,
      task: "An errand is being dispatched",
      workspaceId: alice.workspaceId,
    });
    contents.set("workers/files.py", code);
    expect(
      (await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)).kind
    ).toBe("ready");
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });
});

describe(
  "recovering a files errand after a profile-only park",
  { timeout: 60_000 },
  () => {
    it.each([false, true])(
      "binds only the recovered run in the same root conversation (wrong root: %s)",
      async (wrongRoot) => {
        vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", alice.workspaceId);
        const pool = await loadPool();
        const records = await import("@db/services/browser-runs");
        const { BrowserUseError } =
          await import("@agent/lib/browser-use/errors");
        const { browserTask } = await import("@agent/tools/browser_task");
        const references = await import("@agent/lib/browser-use/files");
        const shared = await import("@agent/lib/sandbox/files");
        const source = "https://example.test/eve/v1/sandbox-files/owned.pdf";
        const bytes = new TextEncoder().encode("synthetic PDF");
        vi.spyOn(references, "reportedSharedFileLinks").mockReturnValue([
          source,
        ]);
        vi.spyOn(shared, "readOwnedSharedFile").mockResolvedValue({
          bytes,
          mediaType: "application/pdf",
          name: "owned.pdf",
        });
        const original = await records.createBrowserRun(alice, {
          conversationChannel: "eve",
          conversationId: "root-1",
          id: "old-run",
          profileId: `vm:${alice.workspaceId}:p1`,
          rootSessionId: "root-1",
          sessionId: `vm:${alice.workspaceId}:s:old`,
          site: "https://example.test",
          status: "done",
          task: "Inspect the file requirement",
        });
        const recoveredSession = `vm:${alice.workspaceId}:s:recovered`;
        const continueErrand = vi
          .spyOn(browserTask, "execute")
          .mockImplementationOnce(async () => {
            await records.createBrowserRun(
              alice,
              {
                conversationChannel: "eve",
                conversationId: "root-1",
                id: "recovered-run",
                profileId: original.profileId,
                rootSessionId: wrongRoot ? "another-root" : "root-1",
                sessionId: recoveredSession,
                site: original.site,
                status: "running",
                task: "Await approved files",
              },
              original.id
            );
            return {
              note: "Recovered",
              runId: "recovered-run",
              status: "running",
            };
          })
          .mockResolvedValue({
            note: "Attached",
            runId: "attachment-run",
            status: "running",
          });
        const upload = vi
          .spyOn(pool.runs, "uploadBrowserVmSessionFile")
          .mockRejectedValueOnce(
            new BrowserUseError(404, "browser-vm", "no such session")
          )
          .mockResolvedValue({
            path: "/workspace/uploads/owned.pdf",
            size: bytes.byteLength,
          });
        const context = {
          abortSignal: new AbortController().signal,
          callId: "file-call",
          async getSandbox() {
            return {
              delete: unusedFileSandboxIo,
              id: "unused-sandbox",
              readBinaryFile: unusedFileSandboxIo,
              readFile: unusedFileSandboxIo,
              readTextFile: unusedFileSandboxIo,
              removePath: unusedFileSandboxIo,
              resolvePath: (path: string) => path,
              run: unusedFileSandboxIo,
              setNetworkPolicy: unusedFileSandboxIo,
              spawn: unusedFileSandboxIo,
              stop: unusedFileSandboxIo,
              writeBinaryFile: unusedFileSandboxIo,
              writeFile: unusedFileSandboxIo,
              writeTextFile: unusedFileSandboxIo,
            };
          },
          getSkill() {
            throw new Error("No skill is needed");
          },
          getToken() {
            throw new Error("No token is needed");
          },
          requireAuth() {
            throw new Error("No inline auth is needed");
          },
          session: {
            auth: {
              current: {
                attributes: { workspaceId: alice.workspaceId },
                authenticator: "authjs",
                principalId: alice.userId,
                principalType: "user",
              },
              initiator: null,
            },
            id: "root-1",
            turn: { id: "turn-1", sequence: 1 },
          },
          toolName: "browser_files",
        } satisfies ToolContext;
        const { default: files } = await import("@agent/tools/browser_files");
        const resolve = files.events["step.started"];
        if (!resolve) throw new Error("Files must resolve per step");
        const tools = await resolve({}, {
          channel: { kind: "channel:eve" },
          messages: [{ content: "Attach the approved file", role: "user" }],
          model: null,
          session: context.session,
        } satisfies DynamicResolveContext);
        if (!tools || "execute" in tools)
          throw new Error("The files tool must resolve");
        const result = await tools.browser_files.execute(
          {
            action: "upload",
            sources: [source],
            runId: original.id,
            site: original.site ?? "",
          },
          context
        );
        expect(continueErrand.mock.calls[0]?.[0]).toMatchObject({
          action: "continue",
          personWants: "look",
          runId: original.id,
        });
        expect(continueErrand.mock.calls[0]?.[0].task).toContain(
          "Do not inspect or act on the website"
        );
        expect(continueErrand.mock.calls[0]?.[1].session).toMatchObject({
          id: "root-1",
          auth: { current: { authenticator: "browser-files" } },
        });
        expect(result).toMatchObject(
          wrongRoot
            ? {
                files: [],
                status: "browser_unavailable",
              }
            : {
                runId: "attachment-run",
                status: "uploaded",
              }
        );
        expect(upload.mock.calls.map(([session]) => session)).toEqual([
          original.sessionId,
          ...(wrongRoot ? [] : [recoveredSession]),
        ]);
        expect(continueErrand.mock.calls.map(([input]) => input.runId)).toEqual(
          wrongRoot ? [original.id] : [original.id, "recovered-run"]
        );
        expect(
          continueErrand.mock.calls[1]?.[0].task?.includes(
            "/workspace/uploads/owned.pdf"
          )
        ).toBe(wrongRoot ? undefined : true);
      }
    );
  }
);

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
    // Found by its id, once: never handed over, nor looked up by name.
    expect(cloud.readCloudRuVm).toHaveBeenCalledOnce();
    expect(cloud.findCloudRuVmByName).not.toHaveBeenCalled();
    expect(cloud.deleteCloudRuFloatingIp).not.toHaveBeenCalled();
    expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
  });
});

describe("handing a pool workspace's gone VM over", { timeout: 60_000 }, () => {
  /** Alice's record naming a VM of her own, `vm-alice`, in `state`. */
  async function seedOwnVm(
    pool: Pool,
    patch: Parameters<Pool["vms"]["updateBrowserVm"]>[1] = {}
  ) {
    return seedAlice(pool, {
      bootDiskId: "disk-alice",
      floatingIpId: "fip-alice",
      generation: 2,
      host: "45.132.176.9",
      image: "bro-browser-test-1",
      proxySession: "bro0123456789abr1",
      state: "stopped",
      vmId: "vm-alice",
      vmName: "bro-wsalice-2",
      ...patch,
    });
  }

  /** Cloud.ru has the pool's hosts and nothing of Alice's. */
  function aliceVmGone() {
    cloud.readCloudRuVm.mockImplementation(async (id) =>
      id.startsWith("vm-host-")
        ? {
            bootDiskId: `disk-${id}`,
            floatingIpId: `fip-${id}`,
            host: id === "vm-host-2" ? secondAddress : firstAddress,
            id,
            state: "running",
          }
        : undefined
    );
  }

  it("hands a VM gone by its id and its name over, and starts a fresh sandbox", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedOwnVm(pool, { poweredOnAt: minutes(-90), state: "failed" });
    aliceVmGone();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const started = await pool.lifecycle.ensureBrowserVm(
      alice.workspaceId,
      now
    );

    expect(started).toMatchObject({
      kind: "ready",
      vm: {
        bootDiskId: null,
        floatingIpId: null,
        generation: 3,
        hostId: "bro-host-1",
        image: null,
        profileGeneration: 2,
        proxySession: "bro0123456789abr1",
        sandboxState: "running",
        state: "ready",
        vmId: null,
        vmName: null,
      },
    });
    expect(cloud.readCloudRuVm).toHaveBeenCalledWith("vm-alice");
    expect(cloud.findCloudRuVmByName).toHaveBeenCalledExactlyOnceWith(
      "bro-wsalice-2"
    );
    expect(cloud.deleteCloudRuFloatingIp).toHaveBeenCalledWith("fip-alice");
    expect(cloud.deleteCloudRuBackupsOf).toHaveBeenCalledWith(["disk-alice"]);
    expect(cloud.createCloudRuVm).not.toHaveBeenCalled();
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
    expect(hostClient.startBrowserSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bro-host-1" }),
      { from: undefined, generation: 3, workspaceId: alice.workspaceId }
    );
    expect(info).toHaveBeenCalledWith(
      "[browser-pool] a gone VM was handed over to the pool",
      {
        vmId: "vm-alice",
        vmName: "bro-wsalice-2",
        workspaceId: alice.workspaceId,
      }
    );
    // The VM's last stretch is charged as the VM's, not the sandbox's.
    expect(await pool.costsOf()).toContainEqual(
      expect.objectContaining({
        idempotencyKey: `browser-vm:${alice.workspaceId}:${minutes(-90).toISOString()}`,
      })
    );
  });

  it("keeps a VM Cloud.ru knows by its name, and tells the owner", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedOwnVm(pool);
    aliceVmGone();
    cloud.findCloudRuVmByName.mockResolvedValue({
      bootDiskId: "disk-other",
      floatingIpId: undefined,
      host: undefined,
      id: "vm-other",
      state: "stopped",
    });

    const started = await pool.lifecycle.ensureBrowserVm(
      alice.workspaceId,
      now
    );

    expect(started).toEqual({ kind: "starting", retryAfterMs: 600_000 });
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      sandboxState: null,
      vmId: "vm-alice",
      vmName: "bro-wsalice-2",
    });
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      `browser-pool-handover:${alice.workspaceId}`,
      expect.stringContaining("vm-other"),
      expect.anything()
    );
    expect(cloud.deleteCloudRuFloatingIp).not.toHaveBeenCalled();
    expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
  });

  it("takes up the VM a lost create left under the record's name", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedOwnVm(pool, {
      bootDiskId: null,
      floatingIpId: null,
      host: null,
      state: "failed",
      vmId: null,
    });
    aliceVmGone();
    cloud.findCloudRuVmByName.mockResolvedValue({
      bootDiskId: "disk-found",
      floatingIpId: "fip-found",
      host: "45.132.176.10",
      id: "vm-found",
      state: "stopped",
    });

    const started = await pool.lifecycle.ensureBrowserVm(
      alice.workspaceId,
      now
    );

    // It is the workspace's own VM: started, neither alerted nor handed over.
    expect(started).toEqual({ kind: "starting", retryAfterMs: 60_000 });
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      bootDiskId: "disk-found",
      floatingIpId: "fip-found",
      host: "45.132.176.10",
      sandboxState: null,
      state: "starting",
      vmId: "vm-found",
      vmName: "bro-wsalice-2",
    });
    expect(cloud.findCloudRuVmByName).toHaveBeenCalledExactlyOnceWith(
      "bro-wsalice-2"
    );
    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-found",
      "power_on"
    );
    expect(alertOwner).not.toHaveBeenCalled();
    expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
  });

  it("lets a failed power-on of a live VM reach the errand", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedOwnVm(pool);
    const { CloudRuError } = await import("@agent/lib/browser-vm/cloudru");
    cloud.readCloudRuVm.mockImplementation(async (id) => ({
      bootDiskId: `disk-${id}`,
      floatingIpId: `fip-${id}`,
      host: firstAddress,
      id,
      state: "stopped",
    }));
    cloud.setCloudRuVmPower.mockRejectedValue(
      new CloudRuError(503, "/v1/vms/vm-alice/set-power", "unavailable")
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
    ).rejects.toThrow(CloudRuError);
    expect(warn).not.toHaveBeenCalledWith(
      "[browser-pool] Cloud.ru could not confirm the VM gone",
      expect.anything()
    );
    expect(cloud.findCloudRuVmByName).not.toHaveBeenCalled();
  });

  it.each([
    ["recorded on the second try", 1, true],
    ["let go after two failed tries", 2, false],
  ])(
    "hands over with the VM's last stretch %s",
    async (_case, failures, recorded) => {
      const pool = await loadPool();
      await seedHost(pool, 1);
      await seedOwnVm(pool, { poweredOnAt: minutes(-90), state: "failed" });
      aliceVmGone();
      await pool.failVmUptimeWrites(failures);
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      const started = await pool.lifecycle.ensureBrowserVm(
        alice.workspaceId,
        now
      );

      expect(started).toMatchObject({ kind: "ready" });
      const stretchKey = `browser-vm:${alice.workspaceId}:${minutes(-90).toISOString()}`;
      const costs = await pool.costsOf();
      expect({
        recorded: costs.some((cost) => cost.idempotencyKey === stretchKey),
        warned: warn.mock.calls.some(
          ([line]) =>
            line === "[usage-costs] the gone VM's last stretch was not recorded"
        ),
      }).toEqual({ recorded, warned: !recorded });
      // The sandbox's own stretch starts afresh, never from the VM's.
      expect(
        (await pool.vms.readBrowserVm(alice.workspaceId))?.poweredOnAt
      ).not.toEqual(minutes(-90));
    }
  );

  it("hands nothing over while a run may be open on the VM", async () => {
    const pool = await loadPool();
    await seedHost(pool, 1);
    await seedOwnVm(pool);
    aliceVmGone();
    await pool.vms.recordBrowserVmRun({
      id: `vm:${alice.workspaceId}:r:1`,
      sessionId: `vm:${alice.workspaceId}:s:1`,
      status: "running",
      task: "Find a table",
      workspaceId: alice.workspaceId,
    });

    const started = await pool.lifecycle.ensureBrowserVm(
      alice.workspaceId,
      now
    );

    expect(started).toEqual({ kind: "starting", retryAfterMs: 45_000 });
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      floatingIpId: "fip-alice",
      sandboxState: null,
      vmId: "vm-alice",
    });
    // The run is checked before the name is asked for: one Cloud.ru call a try.
    expect(cloud.readCloudRuVm).toHaveBeenCalledOnce();
    expect(cloud.findCloudRuVmByName).not.toHaveBeenCalled();
    expect(cloud.deleteCloudRuFloatingIp).not.toHaveBeenCalled();
    expect(cloud.createCloudRuVm).not.toHaveBeenCalled();
    expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Cloud.ru answers the VM's read with a 503",
      async () => {
        const { CloudRuError } = await import("@agent/lib/browser-vm/cloudru");
        cloud.readCloudRuVm.mockRejectedValue(
          new CloudRuError(503, "/v1/vms/vm-alice", "unavailable")
        );
      },
    ],
    [
      "the lookup by name times out",
      async () => {
        aliceVmGone();
        cloud.findCloudRuVmByName.mockRejectedValue(
          new DOMException("The operation timed out.", "TimeoutError")
        );
      },
    ],
  ])(
    "hands nothing over when %s, and asks again later",
    async (_case, failCloudRu) => {
      const pool = await loadPool();
      await seedHost(pool, 1);
      await seedOwnVm(pool);
      await failCloudRu();

      const started = await pool.lifecycle.ensureBrowserVm(
        alice.workspaceId,
        now
      );

      expect(started).toEqual({ kind: "starting", retryAfterMs: 60_000 });
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        sandboxState: null,
        state: "stopped",
        vmId: "vm-alice",
        vmName: "bro-wsalice-2",
      });
      expect(cloud.createCloudRuVm).not.toHaveBeenCalled();
      expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
    }
  );

  it("asks Cloud.ru nothing new for a workspace outside the pool", async () => {
    const pool = await loadPool();
    await pool.vms.ensureBrowserVmRecord(bob.workspaceId);
    await pool.vms.updateBrowserVm(
      bob.workspaceId,
      { state: "stopped", vmId: "vm-bob-old", vmName: "bro-wsbob-1" },
      minutes(-60)
    );
    cloud.readCloudRuVm.mockResolvedValue(undefined);

    const started = await pool.lifecycle.ensureBrowserVm(bob.workspaceId, now);

    // As before the pool: its gone VM is forgotten and another created.
    expect(started).toEqual({ kind: "starting", retryAfterMs: 180_000 });
    expect(cloud.findCloudRuVmByName).not.toHaveBeenCalled();
    expect(cloud.createCloudRuVm).toHaveBeenCalledOnce();
    expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
    expect(await pool.vms.readBrowserVm(bob.workspaceId)).toMatchObject({
      sandboxState: null,
      state: "creating",
      vmId: "vm-bob",
    });
  });

  it.each([
    ["failed", "failed", false],
    ["stopped with sign-ins to forget", "stopped", true],
    ["starting", "starting", false],
    ["stopping", "stopping", false],
  ] as const)(
    "has the reconcile hand a gone %s VM over rather than bring it back",
    async (_case, state, profileResetPending) => {
      const pool = await loadPool();
      await seedOwnVm(pool, { profileResetPending, state });
      aliceVmGone();

      await pool.lifecycle.reconcileBrowserVms(now);

      expect(cloud.readCloudRuVm).toHaveBeenCalledWith("vm-alice");
      expect(cloud.findCloudRuVmByName).toHaveBeenCalledExactlyOnceWith(
        "bro-wsalice-2"
      );
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        floatingIpId: null,
        profileGeneration: 2,
        profileResetPending: false,
        sandboxState: null,
        state: "stopped",
        vmId: null,
        vmName: null,
      });
      expect(cloud.deleteCloudRuFloatingIp).toHaveBeenCalledWith("fip-alice");
      expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
      expect(cloud.createCloudRuVm).not.toHaveBeenCalled();
      expect(cloud.createCloudRuHostVm).not.toHaveBeenCalled();
    }
  );

  it("has the reconcile forget a gone VM outside the pool as before", async () => {
    const pool = await loadPool();
    await pool.vms.ensureBrowserVmRecord(bob.workspaceId);
    await pool.vms.updateBrowserVm(
      bob.workspaceId,
      {
        profileResetPending: true,
        state: "stopped",
        vmId: "vm-bob",
        vmName: "bro-wsbob-1",
      },
      minutes(-60)
    );
    cloud.readCloudRuVm.mockResolvedValue(undefined);

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(cloud.readCloudRuVm).toHaveBeenCalledWith("vm-bob");
    expect(cloud.findCloudRuVmByName).not.toHaveBeenCalled();
    expect(await pool.vms.readBrowserVm(bob.workspaceId)).toMatchObject({
      profileGeneration: 2,
      sandboxState: null,
      state: "stopped",
      vmId: null,
      // Not handed over: the next errand creates its VM under the name's stem.
      vmName: "bro-wsbob-1",
    });
  });

  it("has the reconcile keep a VM its name still finds, and tell the owner", async () => {
    const pool = await loadPool();
    const seeded = await seedOwnVm(pool, { state: "starting" });
    aliceVmGone();
    cloud.findCloudRuVmByName.mockResolvedValue({
      bootDiskId: "disk-other",
      floatingIpId: undefined,
      host: undefined,
      id: "vm-other",
      state: "running",
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      floatingIpId: "fip-alice",
      profileGeneration: seeded.profileGeneration,
      state: "starting",
      vmId: "vm-alice",
      vmName: "bro-wsalice-2",
    });
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      `browser-pool-handover:${alice.workspaceId}`,
      expect.stringContaining("vm-other"),
      expect.anything()
    );
    expect(cloud.deleteCloudRuFloatingIp).not.toHaveBeenCalled();
  });

  it("has the reconcile hand nothing over when the name cannot be asked", async () => {
    const pool = await loadPool();
    const seeded = await seedOwnVm(pool, { state: "failed" });
    aliceVmGone();
    cloud.findCloudRuVmByName.mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError")
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      floatingIpId: "fip-alice",
      profileGeneration: seeded.profileGeneration,
      state: "failed",
      vmId: "vm-alice",
      vmName: "bro-wsalice-2",
    });
    expect(alertOwner).not.toHaveBeenCalled();
    expect(cloud.deleteCloudRuFloatingIp).not.toHaveBeenCalled();
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

  it("moves a sandbox off a server taken off BROWSER_HOST_STATIC at once, inside its idle window", async () => {
    // The errand waiting for it would keep an idle sandbox from parking, and
    // the retired server serves no errand: the two would wait on each other.
    const pool = await loadPool({
      BROWSER_HOST_CLOUD: "static",
      BROWSER_HOST_STATIC: "static-2@203.0.113.11",
    });
    await seedRunning(pool, 1);
    hostClient.parkBrowserSandbox.mockResolvedValue(parked(3));

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(hostClient.parkBrowserSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bro-host-1" }),
      expect.objectContaining({ generation: 3, workspaceId: alice.workspaceId })
    );
    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      hostId: null,
      sandboxState: "parked",
      snapshotGeneration: 3,
    });
  });

  it("keeps a sandbox on a listed server while its hostd is silent", async () => {
    // The server may be fine: once hostd answers again, a record taken off it
    // would let the sweep delete the sandbox with its new sign-ins.
    const pool = await loadPool({
      BROWSER_HOST_CLOUD: "static",
      BROWSER_HOST_STATIC: `bro-host-1@${firstAddress}`,
    });
    await seedRunning(pool, 1);
    await pool.hosts.updateBrowserHost(
      "bro-host-1",
      { floatingIpId: null, state: "failed", vmId: null },
      minutes(-1)
    );
    hostClient.readBrowserHostHealth.mockRejectedValue(new Error("timeout"));
    hostClient.readBrowserHostCapacity.mockRejectedValue(new Error("timeout"));

    await pool.lifecycle.reconcileBrowserVms(now);

    expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
      hostId: "bro-host-1",
      sandboxState: "running",
    });
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

/** Alice's sandbox parked into its set of generation 3. */
async function seedParked(
  pool: Pool,
  patch: Parameters<Pool["vms"]["updateBrowserVm"]>[1] = {}
) {
  return seedAlice(pool, {
    generation: 3,
    sandboxState: "parked",
    snapshotChunks: 5,
    snapshotGeneration: 3,
    snapshotKey: `sets/${aliceSandbox}/3/`,
    ...patch,
  });
}

async function pause(ms: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe(
  "warming a sandbox up for a person who wrote",
  { timeout: 60_000 },
  () => {
    it("starts a parked sandbox from its set on a host in service, and parks it after a short window if no errand comes", async () => {
      const pool = await loadPool();
      await seedHost(pool, 1);
      // An errand nobody waited for left a stop that passed long ago.
      await seedParked(pool, { stopNotBefore: minutes(-30) });
      hostClient.startBrowserSandbox.mockImplementation(async (_host, input) =>
        sandbox({ generation: input.generation, path: "restored" })
      );
      const info = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);

      await pool.sandboxes.prewarmBrowserSandbox(alice.workspaceId, now);

      expect(hostClient.startBrowserSandbox).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "bro-host-1" }),
        {
          from: { chunks: 5, key: `sets/${aliceSandbox}/3/`, snapshot: true },
          generation: 4,
          workspaceId: alice.workspaceId,
        }
      );
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        hostId: "bro-host-1",
        lastUsedAt: now,
        leaseUntil: null,
        sandboxState: "running",
        state: "ready",
        stopNotBefore: minutes(10),
      });
      expect(info).toHaveBeenCalledWith(
        "[browser-pool] a sandbox was warmed up",
        expect.objectContaining({
          generation: 4,
          workspaceId: alice.workspaceId,
        })
      );
      expect(cloud.createCloudRuHostVm).not.toHaveBeenCalled();

      // Unused, it parks ten minutes on, not after the twenty of an errand.
      hostClient.parkBrowserSandbox.mockResolvedValue(parked(4));
      await pool.lifecycle.reconcileBrowserVms(minutes(9));
      expect(hostClient.parkBrowserSandbox).not.toHaveBeenCalled();
      await pool.lifecycle.reconcileBrowserVms(minutes(10));
      expect(hostClient.parkBrowserSandbox).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "bro-host-1" }),
        { ample: false, generation: 4, workspaceId: alice.workspaceId }
      );
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        hostId: null,
        sandboxState: "parked",
        snapshotKey: `sets/${aliceSandbox}/4/`,
      });
    });

    it("moves a warmed sandbox to the person's own window once their errand uses it", async () => {
      const pool = await loadPool();
      await seedHost(pool, 1);
      await seedParked(pool);
      vi.spyOn(console, "info").mockImplementation(() => undefined);

      await pool.sandboxes.prewarmBrowserSandbox(alice.workspaceId, now);
      await pool.idle.keepBrowserVmForErrand(
        alice.workspaceId,
        true,
        minutes(1)
      );
      expect(
        await pool.lifecycle.ensureBrowserVm(alice.workspaceId, minutes(1))
      ).toMatchObject({ kind: "ready", vm: { lastUsedAt: minutes(1) } });
      // The errand found it up: nothing started twice.
      expect(hostClient.startBrowserSandbox).toHaveBeenCalledOnce();

      hostClient.parkBrowserSandbox.mockResolvedValue(parked(4));
      await pool.lifecycle.reconcileBrowserVms(minutes(12));
      expect(hostClient.parkBrowserSandbox).not.toHaveBeenCalled();
      await pool.lifecycle.reconcileBrowserVms(minutes(21));
      expect(hostClient.parkBrowserSandbox).toHaveBeenCalledOnce();
    });

    it("leaves a running sandbox and its idle window alone", async () => {
      const pool = await loadPool();
      await seedRunning(pool, 5);

      await pool.sandboxes.prewarmBrowserSandbox(alice.workspaceId, now);

      expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
      expect(worker.readBrowserVmWorkerHealth).not.toHaveBeenCalled();
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        lastUsedAt: minutes(-5),
        stopNotBefore: null,
      });
    });

    it("starts nothing without a host in service, and has the pool bring one up instead", async () => {
      const pool = await loadPool();
      await seedParked(pool);
      cloud.createCloudRuHostVm.mockResolvedValue({
        id: "vm-host-1",
        image: "ubuntu-22.04",
        name: "bro-host-1",
      });

      await pool.sandboxes.prewarmBrowserSandbox(alice.workspaceId, now);

      expect(cloud.createCloudRuHostVm).toHaveBeenCalledOnce();
      expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        generation: 3,
        hostId: null,
        leaseUntil: null,
        sandboxState: "parked",
      });
    });

    it("never starts one with a run open, a failed set or sign-ins to forget, and wipes nothing", async () => {
      const pool = await loadPool();
      await seedHost(pool, 1);
      await seedParked(pool, { profileResetPending: true });
      bucket.add(`sets/${aliceSandbox}/3/manifest.json`);

      await pool.sandboxes.prewarmBrowserSandbox(alice.workspaceId, now);
      await pool.vms.updateBrowserVm(alice.workspaceId, {
        profileResetPending: false,
        sandboxState: "failed",
      });
      await pool.sandboxes.prewarmBrowserSandbox(alice.workspaceId, now);
      await pool.vms.updateBrowserVm(alice.workspaceId, {
        sandboxState: "parked",
      });
      await pool.vms.recordBrowserVmRun({
        id: `vm:${alice.workspaceId}:r:1`,
        sessionId: `vm:${alice.workspaceId}:s:1`,
        status: "running",
        task: "Find a hand cream",
        workspaceId: alice.workspaceId,
      });
      await pool.sandboxes.prewarmBrowserSandbox(alice.workspaceId, now);

      expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
      expect([...bucket]).toEqual([`sets/${aliceSandbox}/3/manifest.json`]);
      expect(await pool.vms.readBrowserVm(alice.workspaceId)).toMatchObject({
        snapshotKey: `sets/${aliceSandbox}/3/`,
      });
    });

    it("has an errand that comes mid-warm-up wait for it in its own call, not in the queue", async () => {
      const pool = await loadPool();
      await seedHost(pool, 1);
      await seedParked(pool);
      // The warm-up holds the lease and has written its start.
      const held = await pool.vms.claimBrowserVmLease(
        alice.workspaceId,
        now,
        6 * 60_000
      );
      await pool.vms.updateBrowserVm(
        alice.workspaceId,
        {
          generation: 4,
          host: firstAddress,
          hostId: "bro-host-1",
          sandboxState: "restoring",
          state: "starting",
        },
        now,
        held?.leaseUntil ?? undefined
      );
      const warmed = (async () => {
        await pause(1500);
        await pool.vms.updateBrowserVm(
          alice.workspaceId,
          { lastUsedAt: now, sandboxState: "running", state: "ready" },
          now
        );
        await pool.vms.releaseBrowserVmLease(alice.workspaceId);
      })();

      const started = await pool.lifecycle.ensureBrowserVm(
        alice.workspaceId,
        now
      );
      await warmed;

      expect(started).toMatchObject({
        kind: "ready",
        vm: { generation: 4, hostId: "bro-host-1", sandboxState: "running" },
      });
      expect(hostClient.startBrowserSandbox).not.toHaveBeenCalled();
    });

    it("sends an errand behind a park to the queue at once", async () => {
      const pool = await loadPool();
      await seedRunning(pool, 30);
      const held = await pool.vms.claimBrowserVmLease(
        alice.workspaceId,
        now,
        6 * 60_000
      );
      await pool.vms.updateBrowserVm(
        alice.workspaceId,
        { sandboxState: "parking", state: "stopping" },
        now,
        held?.leaseUntil ?? undefined
      );
      const began = Date.now();

      expect(
        await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
      ).toEqual({ kind: "starting", retryAfterMs: 15_000 });
      expect(Date.now() - began).toBeLessThan(1000);
    });

    it("lets a worker whose Chrome is still coming up take the errand while its proxy is unset", async () => {
      const pool = await loadPool();
      await seedRunning(pool, 1);

      // The errand's session sets the proxy, which starts Chrome and waits.
      worker.readBrowserVmWorkerHealth.mockResolvedValue(
        health({ chrome: false, proxy: false })
      );
      expect(
        await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
      ).toMatchObject({ kind: "ready" });

      // With the proxy set, a Chrome that is down is not the errand's to fix.
      worker.readBrowserVmWorkerHealth.mockResolvedValue(
        health({ chrome: false, proxy: true })
      );
      expect(
        await pool.lifecycle.ensureBrowserVm(alice.workspaceId, now)
      ).toEqual({ kind: "starting", retryAfterMs: 15_000 });
    });
  }
);

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
