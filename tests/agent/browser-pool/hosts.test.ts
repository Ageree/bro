import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  setCloudRuVmPower: vi.fn<typeof cloudRuModule.setCloudRuVmPower>(),
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
  cloud.setCloudRuVmPower.mockResolvedValue(undefined);
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

/** The hosts module alone, for what needs no database. */
async function loadHosts() {
  return importWithSettings(
    browserPoolTestEnvironment,
    async () => import("@agent/lib/browser-pool/hosts")
  );
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
  aptMirror: z.string(),
  runscRelease: z.string(),
  runtime: z.string(),
});

/**
 * What `python3 boot.py cloud-init` writes for the same host, URLs and
 * settings: the source of truth the TypeScript copy must match byte for
 * byte.
 */
function bootPyCloudInit(
  boot: z.infer<typeof bootSchema>,
  runtime: readonly string[] = []
) {
  const script = fileURLToPath(
    new URL("../../../browser-vm/host/boot.py", import.meta.url)
  );
  return execFileSync(
    "python3",
    [
      script,
      "cloud-init",
      "--host-id",
      boot.hostId,
      "--bundle-url",
      boot.bundle.url,
      "--bundle-sha256",
      boot.bundle.sha256,
      "--rootfs-version",
      boot.rootfs.version,
      "--rootfs-url",
      boot.rootfs.url,
      "--rootfs-sha256",
      boot.rootfs.sha256,
      ...runtime,
    ],
    // The signing key comes from the environment the test stubbed
    // (`importWithSettings`), as boot.py reads BROWSER_VM_SIGNING_KEY.
    { encoding: "utf8" }
  );
}

function bootJson(document: string) {
  const line = document.split("\n")[7] ?? "";
  const json = /^ {4}content: '(?<json>.*)'$/u.exec(line)?.groups?.json;
  return bootSchema.parse(JSON.parse(json ?? ""));
}

describe("browser host cloud-init", () => {
  it("writes the files boot.py writes, with the script it runs", async () => {
    const hosts = await loadHosts();
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
    ).toEqual([
      "hostId",
      "domain",
      "runtime",
      "runscRelease",
      "aptMirror",
      "bundle",
      "rootfs",
    ]);
    expect(boot).toMatchObject({
      aptMirror: "http://mirror.yandex.ru/ubuntu",
      bundle: { sha256: "ab".repeat(32) },
      domain: "",
      hostId: "bro-host-1",
      rootfs: { sha256: "cd".repeat(32), version: "2026-09-30.1" },
      runscRelease: "",
      runtime: "runc",
    });
    const bundleUrl = new URL(boot.bundle.url);
    expect(bundleUrl.origin + bundleUrl.pathname).toBe(
      "https://s3.cloud.ru/bro-state-test/hosts/bundle-1.tgz"
    );
    expect(bundleUrl.searchParams.get("X-Amz-Date")).toBe("20260930T120000Z");
    expect(bundleUrl.searchParams.get("X-Amz-Expires")).toBe("3600");
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

  it("is byte for byte what boot.py writes, under runc and under runsc", async () => {
    const hosts = await loadHosts();
    const document = hosts.browserHostCloudInit("bro-host-1", now);
    expect(bootPyCloudInit(bootJson(document))).toBe(document);

    const runsc = await importWithSettings(
      {
        ...browserPoolTestEnvironment,
        BROWSER_HOST_RUNSC_RELEASE: "20260914",
        BROWSER_HOST_RUNTIME: "runsc",
      },
      async () => import("@agent/lib/browser-pool/hosts")
    );
    const gvisor = runsc.browserHostCloudInit("probe-host-2", now);
    expect(bootJson(gvisor)).toMatchObject({
      runscRelease: "20260914",
      runtime: "runsc",
    });
    expect(
      bootPyCloudInit(bootJson(gvisor), [
        "--runtime",
        "runsc",
        "--runsc-release",
        "20260914",
      ])
    ).toBe(gvisor);
  });

  it("waits minutes for the network before it fetches the bundle", async () => {
    // ru.AZ-1, 30.09: the first boot ran bro-host-boot 3+ minutes before its
    // public address carried any DNS or egress; five tries gave up in 150 s.
    const bootPy = await readFile(
      new URL("../../../browser-vm/host/boot.py", import.meta.url),
      "utf8"
    );
    const script =
      /BOOT_SCRIPT = r"""(?<script>[\s\S]*?)"""/u.exec(bootPy)?.groups
        ?.script ?? "";
    const directory = await mkdtemp(join(tmpdir(), "bro-host-boot-"));
    try {
      const bin = join(directory, "bin");
      await mkdir(bin);
      const stub = async (name: string, body: string) =>
        writeFile(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
      await stub("python3", "echo https://s3.cloud.ru/bundle");
      await stub("sleep", `echo "$1" >> "${directory}/sleeps"`);
      await stub(
        "curl",
        `echo x >> "${directory}/curls"
[ "$(wc -l < "${directory}/curls")" -ge "\${CURL_OK_AT:-0}" ] && [ "\${CURL_OK_AT:-0}" -gt 0 ]`
      );
      await writeFile(join(directory, "boot"), script);
      const run = (curlOkAt: number) =>
        spawnSync("env", [
          "-i",
          `CURL_OK_AT=${String(curlOkAt)}`,
          `PATH=${bin}:/usr/bin:/bin`,
          "bash",
          join(directory, "boot"),
        ]).status;
      const lines = async (name: string) =>
        (await readFile(join(directory, name), "utf8")).trim().split("\n");

      expect(run(0)).toBe(1);
      expect(await lines("curls")).toHaveLength(40);
      const sleeps = (await lines("sleeps")).map(Number);
      // 39 waits of 10 s plus up to 40 connect timeouts of 10 s: 6.5–13 min.
      expect(sleeps.reduce((sum, value) => sum + value, 0)).toBe(390);

      await rm(join(directory, "curls"));
      // The bundle came on the 25th try: no more fetches (the stub's empty
      // file then fails the checksum, before anything is unpacked).
      expect(run(25)).not.toBe(0);
      expect(await lines("curls")).toHaveLength(25);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("runs runsc when the runtime is unset and the release is pinned", async () => {
    // A deployment set up before BROWSER_HOST_RUNTIME stays on gVisor.
    const hosts = await importWithSettings(
      {
        ...browserPoolTestEnvironment,
        BROWSER_HOST_RUNSC_RELEASE: "20260914",
        BROWSER_HOST_RUNTIME: "",
      },
      async () => import("@agent/lib/browser-pool/hosts")
    );

    expect(
      bootJson(hosts.browserHostCloudInit("bro-host-1", now))
    ).toMatchObject({ runscRelease: "20260914", runtime: "runsc" });
  });

  it("needs the gVisor release only under runsc", async () => {
    const hosts = await importWithSettings(
      { ...browserPoolTestEnvironment, BROWSER_HOST_RUNTIME: "runsc" },
      async () => import("@agent/lib/browser-pool/hosts")
    );

    expect(() => hosts.browserHostCloudInit("bro-host-1", now)).toThrow(
      "BROWSER_HOST_RUNSC_RELEASE is not configured"
    );
  });

  it("refuses a host id hostd would not take", async () => {
    const hosts = await loadHosts();

    expect(() => hosts.browserHostCloudInit("Bro:1", now)).toThrow(
      "A host id matches"
    );
  });
});

describe("browser sandbox placement", { timeout: 60_000 }, () => {
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

  it("names hosts with the configured prefix", async () => {
    const { hosts, records } = await loadPool({
      BROWSER_HOST_NAME_PREFIX: "probe-host-",
    });

    await hosts.placeBrowserSandbox(now);
    const [created] = cloud.createCloudRuHostVm.mock.calls[0] ?? [];
    expect(created?.name).toBe("probe-host-1");
    expect(created?.cloudInit).toContain('{"host": "probe-host-1", "key": ');
    expect(await records.readBrowserHost("probe-host-1")).toMatchObject({
      state: "creating",
      vmName: "probe-host-1",
    });
    expect(await records.readBrowserHost("bro-host-1")).toBeUndefined();
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

    // Every host full: the owner hears the pool is full.
    hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(12_288));
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

  it("waits a minute, not five, for hosts without the current root to go", async () => {
    const { hosts, records } = await loadPool();
    await seedHost(records, {
      capacity: {
        committedMb: 0,
        limitMb: 14_976,
        rootfsVersions: ["2026-01-01.1"],
        runsc: null,
        sandboxes: 1,
      },
      state: "ready",
    });
    hostClient.readBrowserHostCapacity.mockResolvedValue({
      ...capacity(3072, [{ state: "running" }]),
      rootfsVersions: ["2026-01-01.1"],
    });

    expect(await hosts.placeBrowserSandbox(now)).toEqual({
      kind: "starting",
      retryAfterMs: 60_000,
    });
    expect(cloud.createCloudRuHostVm).not.toHaveBeenCalled();
    expect(alertOwner).toHaveBeenCalledWith(
      "browser-pool-rootfs",
      expect.stringContaining("2026-09-30.1"),
      expect.anything()
    );
    expect(alertOwner).not.toHaveBeenCalledWith(
      "browser-pool-full",
      expect.anything(),
      expect.anything()
    );

    // The reconcile drains it while it still holds a sandbox, and deletes
    // it once empty, without waiting out the idle hour.
    await hosts.reconcileBrowserHosts(now);
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "draining"
    );
    hostClient.readBrowserHostCapacity.mockResolvedValue({
      ...capacity(0),
      rootfsVersions: ["2026-01-01.1"],
    });
    await hosts.reconcileBrowserHosts(minutes(1));
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "deleting"
    );
  });

  it("takes on a VM a lost create left under the slot's name", async () => {
    const { hosts, records } = await loadPool();
    cloud.findCloudRuVmByName.mockResolvedValue(cloudVm({ id: "vm-left" }));

    expect(await hosts.placeBrowserSandbox(now)).toEqual({
      kind: "starting",
      retryAfterMs: 240_000,
    });
    expect(cloud.createCloudRuHostVm).not.toHaveBeenCalled();
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      leaseUntil: null,
      state: "creating",
      vmId: "vm-left",
    });
  });
});

describe("browser host reconcile", { timeout: 60_000 }, () => {
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

  it("reboots once a new host that never answered, as a first boot may hang", async () => {
    const { hosts, records } = await loadPool();
    await seedHost(records, { state: "creating" });
    await records.updateBrowserHost("bro-host-1", { state: "booting" }, now);
    hostClient.readBrowserHostHealth.mockRejectedValue(new Error("timeout"));

    // Five minutes after the VM ran: maybe a slow mirror, still inside
    // provision.sh's budget. A reboot would cut it off for good (cloud-init
    // runs it once per instance), so it is left alone.
    await hosts.reconcileBrowserHosts(minutes(5));
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();

    await hosts.reconcileBrowserHosts(minutes(6));
    expect(cloud.setCloudRuVmPower).toHaveBeenCalledExactlyOnceWith(
      "vm-host-1",
      "reboot"
    );
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      rebootedAt: minutes(6),
      state: "booting",
    });

    // Still silent after the reboot: never a second one, and failed in time.
    await hosts.reconcileBrowserHosts(minutes(10));
    expect(cloud.setCloudRuVmPower).toHaveBeenCalledOnce();
    await hosts.reconcileBrowserHosts(minutes(15));
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe("failed");
  });

  it("does not reboot a booting host that has answered", async () => {
    const { hosts, records } = await loadPool();
    await seedHost(records, { lastSeenAt: now, state: "creating" });
    await records.updateBrowserHost("bro-host-1", { state: "booting" }, now);
    hostClient.readBrowserHostHealth.mockRejectedValue(new Error("timeout"));

    await hosts.reconcileBrowserHosts(minutes(7));
    expect(cloud.setCloudRuVmPower).not.toHaveBeenCalled();
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
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      createBlockedUntil: minutes(30),
      state: "failed",
    });
    expect(alertOwner).toHaveBeenCalledWith(
      "browser-host-failed:bro-host-1:vm-host-1",
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
    // The VM is gone, but its slot is held for the cool-down: no new host
    // is created (and billed) to fail the same way at once.
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      address: null,
      floatingIpId: null,
      vmId: null,
    });
    expect(await hosts.placeBrowserSandbox(minutes(3))).toEqual({
      kind: "starting",
      retryAfterMs: 300_000,
    });
    expect(cloud.createCloudRuHostVm).not.toHaveBeenCalled();

    await hosts.reconcileBrowserHosts(minutes(10));
    expect(await records.readBrowserHost("bro-host-1")).toBeDefined();
    await hosts.reconcileBrowserHosts(minutes(30));
    expect(await records.readBrowserHost("bro-host-1")).toBeUndefined();
  });

  it("tells the owner of a host Cloud.ru will not delete, even when it refuses outright", async () => {
    const { hosts, records } = await loadPool();
    const { CloudRuError } = await import("@agent/lib/browser-vm/cloudru");
    await seedHost(records, { state: "deleting" });
    cloud.deleteCloudRuVm.mockRejectedValue(
      new CloudRuError(
        409,
        "/api/v1/vms/vm-host-1",
        "vm_can_not_be_deleted_from_current_state"
      )
    );

    await hosts.reconcileBrowserHosts(now);

    expect(alertOwner).toHaveBeenCalledWith(
      "browser-host-delete:bro-host-1",
      expect.stringContaining("bro-host-1"),
      expect.anything()
    );
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "deleting"
    );
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
    // An errand takes the empty draining host back rather than wait for a
    // new one: it is ready again, and empty from now.
    expect(await hosts.placeBrowserSandbox(now)).toMatchObject({
      host: { emptySince: now, id: "bro-host-1", state: "ready" },
      kind: "ready",
    });
    expect(cloud.createCloudRuHostVm).not.toHaveBeenCalled();

    // The placement writes its host before the start: the host holds it.
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await hosts.reconcileBrowserHosts(now);
    expect(await records.readBrowserHost("bro-host-1")).toMatchObject({
      lastError: "The host's hostd stopped answering.",
      state: "failed",
    });
    expect(await records.readBrowserHost("bro-host-2")).toMatchObject({
      lastError: "The host's VM is gone or has another address.",
      state: "failed",
    });
    expect(warn).toHaveBeenCalledWith("[browser-pool] a host failed", {
      hostId: "bro-host-2",
      reason: "The host's VM is gone or has another address.",
      state: "ready",
      vmId: "vm-host-2",
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
