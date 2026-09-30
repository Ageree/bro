import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as cloudRuModule from "@agent/lib/browser-vm/cloudru";
import type * as hostModule from "@agent/lib/browser-pool/host";
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
const address = "45.132.176.117";

const cloud = vi.hoisted(() => ({
  createCloudRuHostVm: vi.fn<typeof cloudRuModule.createCloudRuHostVm>(),
  deleteCloudRuFloatingIp:
    vi.fn<typeof cloudRuModule.deleteCloudRuFloatingIp>(),
  deleteCloudRuVm: vi.fn<typeof cloudRuModule.deleteCloudRuVm>(),
  findCloudRuVmByName: vi.fn<typeof cloudRuModule.findCloudRuVmByName>(),
  readCloudRuVm: vi.fn<typeof cloudRuModule.readCloudRuVm>(),
}));
const hostClient = vi.hoisted(() => ({
  readBrowserHostCapacity: vi.fn<typeof hostModule.readBrowserHostCapacity>(),
  readBrowserHostHealth: vi.fn<typeof hostModule.readBrowserHostHealth>(),
}));
const alertOwner = vi.hoisted(() =>
  vi.fn<typeof ownerAlert.alertOwner>(() => Promise.resolve(true))
);

vi.mock("@agent/lib/browser-vm/cloudru", async (importOriginal) => ({
  ...(await importOriginal<typeof cloudRuModule>()),
  ...cloud,
}));
vi.mock("@agent/lib/browser-pool/host", async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  ...hostClient,
}));
vi.mock("@agent/lib/owner-alert", () => ({ alertOwner }));

const databases: PGlite[] = [];

beforeEach(() => {
  cloud.createCloudRuHostVm.mockResolvedValue({
    id: "vm-host-1",
    image: "ubuntu-22.04",
    name: "bro-host-1",
  });
  cloud.deleteCloudRuVm.mockResolvedValue(undefined);
  cloud.deleteCloudRuFloatingIp.mockResolvedValue(undefined);
  cloud.findCloudRuVmByName.mockResolvedValue(undefined);
  cloud.readCloudRuVm.mockResolvedValue(cloudVm());
});

afterEach(async () => {
  clearBrowserVmSettings();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

function cloudVm(
  overrides: Partial<
    NonNullable<Awaited<ReturnType<typeof cloudRuModule.readCloudRuVm>>>
  > = {}
) {
  return {
    bootDiskId: "disk-host-1",
    floatingIpId: "fip-host-1",
    host: address,
    id: "vm-host-1",
    state: "running",
    ...overrides,
  };
}

function capacity(
  committed: number,
  sandboxes: readonly { state: string }[] = [],
  total = 16_000
) {
  return {
    cpu: { features: "abc", model: "Intel" },
    disk: { freeMb: 30_000, totalMb: 40_000 },
    host: "bro-host-1",
    memoryMb: { available: total - committed, committed, total },
    rootfsVersions: ["2026-09-30.1"],
    runsc: "runsc version release-20260914.0",
    sandboxes: sandboxes.map((sandbox, index) => ({
      generation: 1,
      id: `ws-${String(index)}`,
      memoryMb: 3072,
      state: sandbox.state,
      usedMb: null,
    })),
    shm: { freeMb: 8000, totalMb: 8000 },
  };
}

async function loadPool(settings = {}) {
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  return importWithSettings(
    { ...browserPoolTestEnvironment, ...settings },
    async () => {
      const [Database, scope, vms] = await Promise.all([
        import("@db"),
        import("@db/services/scope"),
        import("@db/services/browser-vms"),
      ]);
      const hosts = await import("@agent/lib/browser-pool/hosts");
      const records = await import("@db/services/browser-hosts");
      vi.spyOn(Database, "db", "get").mockReturnValue(database);
      await scope.ensureScope(alice);
      return { hosts, records, vms };
    }
  );
}

/** A host record in `state`, as if a create had got that far. */
async function seedHost(
  records: Awaited<ReturnType<typeof loadPool>>["records"],
  patch: Parameters<typeof records.updateBrowserHost>[1],
  id = "bro-host-1"
) {
  const slot = await records.claimBrowserHostSlot(4, minutes(-60), 1);
  if (slot?.id !== id)
    throw new Error(`Seeded ${String(slot?.id)}, not ${id}.`);
  await records.releaseBrowserHostLease(id);
  return records.updateBrowserHost(
    id,
    { address, floatingIpId: "fip-host-1", vmId: "vm-host-1", ...patch },
    minutes(-60)
  );
}

const bootSchema = z.object({
  bundle: z.object({ sha256: z.string(), url: z.string() }),
  domain: z.string(),
  hostId: z.string(),
  rootfs: z.object({
    sha256: z.string(),
    url: z.string(),
    version: z.string(),
  }),
  runscRelease: z.string(),
});

describe("browser host cloud-init", () => {
  it("writes the files boot.py writes, with the script it runs", async () => {
    const { hosts } = await loadPool();
    const document = hosts.browserHostCloudInit("bro-host-1", now);
    const lines = document.split("\n");

    expect(lines.slice(0, 5)).toEqual([
      "#cloud-config",
      "write_files:",
      "  - path: /etc/bro/host.json",
      '    permissions: "0600"',
      // The key `boot.host_key` derives for bro-host-1 from the test signing key.
      `    content: '{"host": "bro-host-1", "key": "5e0ea55ff2228191fa2228ec2be4772ae5996067b39209c4e56c51fda74c9d03"}'`,
    ]);
    expect(lines.slice(5, 7)).toEqual([
      "  - path: /etc/bro/boot.json",
      '    permissions: "0600"',
    ]);
    const bootLine = /^ {4}content: '(?<json>.*)'$/u.exec(lines[7] ?? "");
    const boot = bootSchema.parse(JSON.parse(bootLine?.groups?.json ?? ""));
    expect(
      Object.keys(
        z
          .record(z.string(), z.json())
          .parse(JSON.parse(bootLine?.groups?.json ?? "{}"))
      )
    ).toEqual(["hostId", "domain", "runscRelease", "bundle", "rootfs"]);
    expect(boot).toMatchObject({
      bundle: { sha256: "ab".repeat(32) },
      domain: "",
      hostId: "bro-host-1",
      rootfs: { sha256: "cd".repeat(32), version: "2026-09-30.1" },
      runscRelease: "20260914",
    });
    const bundleUrl = new URL(boot.bundle.url);
    expect(bundleUrl.origin + bundleUrl.pathname).toBe(
      "https://s3.cloud.ru/bro-state-test/hosts/bundle-1.tgz"
    );
    expect(bundleUrl.searchParams.get("X-Amz-Date")).toBe("20260930T120000Z");
    expect(bundleUrl.searchParams.get("X-Amz-Expires")).toBe("21600");
    expect(new URL(boot.rootfs.url).pathname).toBe(
      "/bro-state-test/rootfs/2026-09-30.1.tar.zst"
    );
    // Only presigned URLs go to the host, never the Cloud.ru secret.
    expect(document).not.toContain("test-key-secret");

    expect(lines.slice(8, 11)).toEqual([
      "  - path: /usr/local/sbin/bro-host-boot",
      '    permissions: "0700"',
      "    content: |",
    ]);
    const bootPy = await readFile(
      new URL("../../../browser-vm/host/boot.py", import.meta.url),
      "utf8"
    );
    const script = /BOOT_SCRIPT = r"""(?<script>[\s\S]*?)"""/u.exec(bootPy)
      ?.groups?.script;
    expect(script).toBeDefined();
    const indented = (script ?? "")
      .replace(/\n$/u, "")
      .split("\n")
      .map((line) => (line ? `      ${line}` : ""));
    expect(lines.slice(11, 11 + indented.length)).toEqual(indented);
    expect(lines.slice(11 + indented.length)).toEqual([
      "runcmd:",
      '  - [bash, -c, "/usr/local/sbin/bro-host-boot > /var/log/bro-provision.log 2>&1"]',
      "",
    ]);
  });

  it("refuses a host id hostd would not take", async () => {
    const { hosts } = await loadPool();

    expect(() => hosts.browserHostCloudInit("Bro:1", now)).toThrow(
      "A host id matches"
    );
  });
});

describe("browser sandbox placement", () => {
  it("creates the first host in slot one and has the errand wait", async () => {
    const { hosts, records } = await loadPool();

    expect(await hosts.placeBrowserSandbox(now)).toEqual({
      kind: "starting",
      retryAfterMs: 240_000,
    });
    expect(cloud.createCloudRuHostVm).toHaveBeenCalledOnce();
    const [created] = cloud.createCloudRuHostVm.mock.calls[0] ?? [];
    expect(created?.name).toBe("bro-host-1");
    expect(created?.cloudInit).toBe(
      hosts.browserHostCloudInit("bro-host-1", now)
    );
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      leaseUntil: null,
      state: "creating",
      vmId: "vm-host-1",
    });

    // While it comes up, nobody creates another.
    expect(await hosts.placeBrowserSandbox(minutes(1))).toEqual({
      kind: "starting",
      retryAfterMs: 60_000,
    });
    expect(cloud.createCloudRuHostVm).toHaveBeenCalledOnce();
  });

  it("frees the slot when Cloud.ru refuses the host", async () => {
    const { hosts, records } = await loadPool();
    const { CloudRuError } = await import("@agent/lib/browser-vm/cloudru");
    cloud.createCloudRuHostVm.mockRejectedValueOnce(
      new CloudRuError(403, "/api/v1.1/vms", "quota exceeded")
    );

    expect(await hosts.placeBrowserSandbox(now)).toMatchObject({
      kind: "starting",
    });
    expect(await records.listBrowserHosts()).toEqual([]);
    expect(alertOwner).toHaveBeenCalledWith(
      "browser-host-create",
      expect.stringContaining("403"),
      expect.anything()
    );
  });

  it("fills the fullest host that fits the sandbox and the root", async () => {
    const { hosts, records } = await loadPool({ BROWSER_HOST_MAX: "3" });
    await seedHost(records, {
      capacity: {
        committedMb: 0,
        limitMb: 14_976,
        rootfsVersions: [],
        runsc: null,
        sandboxes: 0,
      },
      state: "ready",
    });
    await seedHost(
      records,
      {
        capacity: {
          committedMb: 12_288,
          limitMb: 14_976,
          rootfsVersions: [],
          runsc: null,
          sandboxes: 4,
        },
        state: "ready",
      },
      "bro-host-2"
    );
    await seedHost(
      records,
      {
        capacity: {
          committedMb: 6_144,
          limitMb: 14_976,
          rootfsVersions: [],
          runsc: null,
          sandboxes: 2,
        },
        state: "ready",
      },
      "bro-host-3"
    );
    hostClient.readBrowserHostCapacity.mockImplementation(async (host) => {
      if (host.id === "bro-host-2") return capacity(12_288); // 2688 MB free: too little
      if (host.id === "bro-host-3") return capacity(6_144);
      return capacity(0);
    });

    const placed = await hosts.placeBrowserSandbox(now);
    expect(placed.kind === "ready" ? placed.host.id : placed).toBe(
      "bro-host-3"
    );
    expect(
      hostClient.readBrowserHostCapacity.mock.calls.map(([host]) => host.id)
    ).toEqual(["bro-host-2", "bro-host-3"]);

    // A host without the sandbox root is no place either.
    hostClient.readBrowserHostCapacity.mockImplementation(async (host) => ({
      ...capacity(host.id === "bro-host-2" ? 12_288 : 0),
      rootfsVersions: ["2026-01-01.1"],
    }));
    expect(await hosts.placeBrowserSandbox(now)).toMatchObject({
      kind: "starting",
      retryAfterMs: 300_000,
    });
    expect(cloud.createCloudRuHostVm).not.toHaveBeenCalled();
    expect(alertOwner).toHaveBeenCalledWith(
      "browser-pool-full",
      expect.stringContaining("BROWSER_HOST_MAX = 3"),
      expect.anything()
    );
  });
});

describe("browser host reconcile", () => {
  it("follows a new host up to ready", async () => {
    const { hosts, records } = await loadPool();
    await hosts.placeBrowserSandbox(now);
    cloud.readCloudRuVm.mockResolvedValueOnce(
      cloudVm({ floatingIpId: undefined, host: undefined, state: "creating" })
    );

    await hosts.reconcileBrowserHosts(minutes(1));
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "creating"
    );

    await hosts.reconcileBrowserHosts(minutes(2));
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      address,
      floatingIpId: "fip-host-1",
      state: "booting",
    });

    hostClient.readBrowserHostHealth.mockResolvedValueOnce({
      configured: true,
      hostd: "2026-09-30.1",
      runsc: null,
      stage: "rootfs",
    });
    await hosts.reconcileBrowserHosts(minutes(3));
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      lastSeenAt: minutes(3),
      state: "booting",
    });

    hostClient.readBrowserHostHealth.mockResolvedValueOnce({
      configured: true,
      hostd: "2026-09-30.1",
      runsc: "runsc version release-20260914.0",
      stage: "ready",
    });
    hostClient.readBrowserHostCapacity.mockResolvedValueOnce(capacity(0));
    await hosts.reconcileBrowserHosts(minutes(4));
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      capacity: {
        committedMb: 0,
        limitMb: 14_976,
        rootfsVersions: ["2026-09-30.1"],
        runsc: "runsc version release-20260914.0",
        sandboxes: 0,
      },
      emptySince: minutes(4),
      leaseUntil: null,
      state: "ready",
    });
  });

  it("fails a host whose boot failed, then deletes it with its address", async () => {
    const { hosts, records } = await loadPool();
    await seedHost(records, { state: "booting" });
    hostClient.readBrowserHostHealth.mockResolvedValue({
      configured: true,
      hostd: "2026-09-30.1",
      runsc: null,
      stage: "failed:packages:line 52",
    });

    await hosts.reconcileBrowserHosts(now);
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe("failed");
    expect(alertOwner).toHaveBeenCalledWith(
      "browser-host-failed:bro-host-1",
      expect.stringContaining("failed:packages:line 52"),
      expect.anything()
    );

    await hosts.reconcileBrowserHosts(minutes(1));
    expect(cloud.deleteCloudRuVm).toHaveBeenCalledWith("vm-host-1", {
      diskIds: [],
      floatingIpIds: ["fip-host-1"],
    });
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "deleting"
    );

    cloud.readCloudRuVm.mockResolvedValue(undefined);
    await hosts.reconcileBrowserHosts(minutes(2));
    expect(cloud.deleteCloudRuFloatingIp).toHaveBeenCalledWith("fip-host-1");
    expect(await records.readBrowserHost("bro-host-1")).toBeUndefined();
  });

  it("drains an idle host and deletes it only if it stays empty", async () => {
    const { hosts, records, vms } = await loadPool();
    await seedHost(records, {
      emptySince: minutes(-61),
      lastSeenAt: minutes(-1),
      state: "ready",
    });
    hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(0));

    await hosts.reconcileBrowserHosts(now);
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "draining"
    );
    // Drained hosts take no sandbox.
    expect(await hosts.placeBrowserSandbox(now)).toMatchObject({
      kind: "starting",
    });

    // A placement that raced the drain wrote its host first: back to ready.
    await vms.ensureBrowserVmRecord(alice.workspaceId);
    await vms.updateBrowserVm(alice.workspaceId, {
      hostId: "bro-host-1",
      sandboxState: "starting",
    });
    await hosts.reconcileBrowserHosts(minutes(1));
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      emptySince: null,
      state: "ready",
    });
    expect(cloud.deleteCloudRuVm).not.toHaveBeenCalled();

    // Parked again and idle for the whole hour: drained, then deleted.
    await vms.updateBrowserVm(alice.workspaceId, { sandboxState: "parked" });
    await hosts.reconcileBrowserHosts(minutes(2));
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      emptySince: minutes(2),
      state: "ready",
    });
    await hosts.reconcileBrowserHosts(minutes(62));
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "draining"
    );
    await hosts.reconcileBrowserHosts(minutes(63));
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "deleting"
    );
    expect(cloud.deleteCloudRuVm).toHaveBeenCalledWith("vm-host-1", {
      diskIds: [],
      floatingIpIds: ["fip-host-1"],
    });
  });

  it("keeps a host that holds a sandbox hostd reports, even with no record of it", async () => {
    const { hosts, records } = await loadPool();
    await seedHost(records, { emptySince: minutes(-120), state: "ready" });
    hostClient.readBrowserHostCapacity.mockResolvedValue(
      capacity(3072, [{ state: "running" }, { state: "parked" }])
    );

    await hosts.reconcileBrowserHosts(now);
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      capacity: { committedMb: 3072, sandboxes: 1 },
      emptySince: null,
      lastSeenAt: now,
      state: "ready",
    });
  });

  it("fails a host that went silent or whose address moved", async () => {
    const { hosts, records } = await loadPool({ BROWSER_HOST_MAX: "2" });
    await seedHost(records, { lastSeenAt: minutes(-6), state: "ready" });
    await seedHost(
      records,
      {
        address: "45.132.176.200",
        lastSeenAt: now,
        state: "ready",
        vmId: "vm-host-2",
      },
      "bro-host-2"
    );
    hostClient.readBrowserHostCapacity.mockRejectedValue(new Error("timeout"));

    await hosts.reconcileBrowserHosts(now);
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      lastError: "The host's hostd stopped answering.",
      state: "failed",
    });
    expect(await records.readBrowserHost("bro-host-2")).toMatchObject({
      lastError: "The host's VM is gone or has another address.",
      state: "failed",
    });
  });

  it("finds a host whose create lost its answer, or lets its slot go", async () => {
    const { hosts, records } = await loadPool({ BROWSER_HOST_MAX: "2" });
    await seedHost(records, {
      address: null,
      floatingIpId: null,
      state: "creating",
      vmId: null,
    });
    await seedHost(
      records,
      { address: null, floatingIpId: null, state: "creating", vmId: null },
      "bro-host-2"
    );
    cloud.findCloudRuVmByName.mockImplementation(async (name) =>
      name === "bro-host-1" ? cloudVm() : undefined
    );

    await hosts.reconcileBrowserHosts(now);
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      address,
      state: "booting",
      vmId: "vm-host-1",
    });
    // Nothing by that name an hour after its create: none was made.
    expect(await records.readBrowserHost("bro-host-2")).toBeUndefined();
  });
});

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
