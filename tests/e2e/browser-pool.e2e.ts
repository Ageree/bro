/**
 * Stage 4 of docs/browser-pool.md end to end: Bro's own pool code
 * (`agent/lib/browser-pool/`, the pool branch of
 * `agent/lib/browser-vm/lifecycle.ts`) drives real hosts on Cloud.ru and
 * real sets in Object Storage. No production and no web app: the database is
 * PGlite in memory, and the errand's side is played by this file through
 * Bro's worker client and CDP. Not part of `pnpm check`: it creates VMs and
 * costs money. How to run it, and what it measured — section 10.
 *
 * The scenario: a sandbox for a new workspace from nothing (a host created by
 * `hosts.ts` from stock Ubuntu), the worker and Chrome through the host's
 * Caddy, a cookie marker through CDP; parks by the idle window through
 * `reconcileBrowserVms` and starts from `parked` again, measured; the host's
 * VM deleted behind Bro's back, the watchdog taking the sandbox back to its
 * set and a new host bringing it up with the marker; the workspace deleted
 * with its sets; the empty host drained and deleted by the watchdog.
 *
 * With BROWSER_POOL_E2E_SCENARIO=handover the run is another, shorter one
 * (stage 5, the pilot's handover): the workspace's record names a VM of
 * its own that Cloud.ru does not have, by id or by name, and the first
 * errand hands it over to the pool and gets a sandbox on a new host.
 *
 * Only three things are stood in for: owner alerts are collected rather
 * than sent; with BROWSER_POOL_E2E_CONSOLE=1 a host's user data gets a root
 * password for the serial console (the stand's `console.py`), to look at
 * the sandbox from the host; and `hostd`'s start and park answers are
 * recorded on their way to Bro.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as hostModule from "@agent/lib/browser-pool/host";
import type * as cloudRuModule from "@agent/lib/browser-vm/cloudru";
import type * as ownerAlert from "@agent/lib/owner-alert";
import * as schema from "@db/schema";

const probeDirectory = new URL(
  "../../scripts/cloudru-sandbox-probe/",
  import.meta.url
).pathname;
/**
 * What the run takes from the session: Cloud.ru and Object Storage keys,
 * the pool's artifacts, the model key; optional knobs of the run itself.
 */
const sessionSchema = z.object({
  BROWSER_HOST_BUNDLE: z.string().min(1),
  BROWSER_HOST_FLAVOR: z.string().min(1).default("gen-2-8"),
  BROWSER_HOST_NAME_PREFIX: z
    .string()
    .regex(/^(?!bro-)[a-z][a-z\d-]*-$/u, "not bro-…: Bro's own hosts")
    .default("probe-host-"),
  BROWSER_POOL_E2E_CONSOLE: z.string().optional(),
  BROWSER_POOL_E2E_CYCLES: z.coerce.number().int().min(1).default(6),
  BROWSER_POOL_E2E_SCENARIO: z.enum(["cycles", "handover"]).default("cycles"),
  BROWSER_POOL_E2E_RESULTS: z
    .string()
    .default(join(tmpdir(), "browser-pool-e2e.json")),
  BROWSER_SANDBOX_ROOTFS: z.string().min(1),
  BROWSER_STATE_BUCKET: z.string().min(1),
  BROWSER_VM_LLM_API_KEY: z.string().min(1),
  CLOUDRU_KEY_ID: z.string().min(1),
  CLOUDRU_KEY_SECRET: z.string().min(1),
  CLOUDRU_S3_TENANT_ID: z.string().min(1),
  PROBE_STATE_DIR: z.string().default(join(homedir(), ".bro-probe")),
});

// oxlint-disable-next-line eslint/no-restricted-properties -- The run reads the session's keys once, before any module validates its own settings.
const session = sessionSchema.parse(process.env);
const consoleAccess = session.BROWSER_POOL_E2E_CONSOLE === "1";
const workspaceId = `e2e-pool-${randomBytes(6).toString("hex")}`;
const userId = `e2e-user-${randomBytes(6).toString("hex")}`;

const recorded = vi.hoisted(() => {
  const alerts: { key: string; text: string }[] = [];
  const creates: { at: number; name: string }[] = [];
  const parks: {
    ms: number;
    result: Awaited<ReturnType<typeof hostModule.parkBrowserSandbox>>;
  }[] = [];
  const passwords: string[] = [];
  const starts: {
    ms: number;
    result: Awaited<ReturnType<typeof hostModule.startBrowserSandbox>>;
  }[] = [];
  return { alerts, creates, parks, passwords, starts };
});

vi.mock("@agent/lib/owner-alert", () => ({
  alertOwner: vi.fn<typeof ownerAlert.alertOwner>(async (key, text) => {
    recorded.alerts.push({ key, text });
    console.log(`[e2e] owner alert ${key}: ${text.slice(0, 200)}`);
    return true;
  }),
}));

vi.mock("@agent/lib/browser-pool/host", async (importOriginal) => {
  const original = await importOriginal<typeof hostModule>();
  return {
    ...original,
    parkBrowserSandbox: async (
      ...args: Parameters<typeof original.parkBrowserSandbox>
    ) => {
      const started = performance.now();
      const result = await original.parkBrowserSandbox(...args);
      recorded.parks.push({ ms: performance.now() - started, result });
      return result;
    },
    startBrowserSandbox: async (
      ...args: Parameters<typeof original.startBrowserSandbox>
    ) => {
      const started = performance.now();
      const result = await original.startBrowserSandbox(...args);
      recorded.starts.push({ ms: performance.now() - started, result });
      return result;
    },
  };
});

vi.mock("@agent/lib/browser-vm/cloudru", async (importOriginal) => {
  const original = await importOriginal<typeof cloudRuModule>();
  return {
    ...original,
    createCloudRuHostVm: async (
      input: Parameters<typeof original.createCloudRuHostVm>[0]
    ) => {
      recorded.creates.push({ at: Date.now(), name: input.name });
      if (!consoleAccess) return original.createCloudRuHostVm(input);
      // The stand's serial-console login (`console.py`): Bro's hosts have none.
      const password = `Pr${randomBytes(8).toString("hex")}9!`;
      const file = join(session.PROBE_STATE_DIR, `${input.name}.password`);
      await writeFile(file, password, { mode: 0o600 });
      recorded.passwords.push(file);
      return original.createCloudRuHostVm({
        ...input,
        cloudInit: `${input.cloudInit}chpasswd:\n  expire: false\n  users:\n    - {name: root, password: "${password}", type: text}\nssh_pwauth: false\n`,
      });
    },
  };
});

/**
 * Bro's settings for this run, before any of its modules is loaded: keys of
 * the run's own (never production's), one host of the probe's prefix, the
 * pool for this workspace alone, a dummy residential proxy (nothing is
 * browsed) and dummies for what the run does not reach.
 */
const settings = {
  BETTER_AUTH_SECRET: randomBytes(24).toString("hex"),
  BETTER_AUTH_URL: "http://127.0.0.1:9",
  BROWSER_BACKEND: "",
  BROWSER_HOST_BUNDLE: session.BROWSER_HOST_BUNDLE,
  BROWSER_HOST_FLAVOR: session.BROWSER_HOST_FLAVOR,
  BROWSER_HOST_IDLE_MINUTES: "30",
  BROWSER_HOST_MAX: "1",
  BROWSER_HOST_NAME_PREFIX: session.BROWSER_HOST_NAME_PREFIX,
  // The bundle and root of section 2 are runc's; without it a session that
  // has no BROWSER_HOST_RUNSC_RELEASE has no pool at all.
  BROWSER_HOST_RUNTIME: "runc",
  BROWSER_POOL_WORKSPACES: workspaceId,
  BROWSER_SANDBOX_ROOTFS: session.BROWSER_SANDBOX_ROOTFS,
  BROWSER_STATE_BUCKET: session.BROWSER_STATE_BUCKET,
  BROWSER_STATE_KEY: randomBytes(32).toString("hex"),
  BROWSER_VM_IDLE_MINUTES: "3",
  BROWSER_VM_LLM_API_KEY: session.BROWSER_VM_LLM_API_KEY,
  BROWSER_VM_PROXY: "proxy.invalid:9000:probe-{session}:none",
  BROWSER_VM_SIGNING_KEY: randomBytes(32).toString("hex"),
  BROWSER_VM_WORKSPACES: "",
  CLOUDRU_BROWSER_IMAGE: "",
  DATABASE_URL: "postgresql://e2e:e2e@127.0.0.1:9/e2e",
  TELEGRAM_OWNER_CHAT_ID: "",
};
for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);

const databases: PGlite[] = [];
/** Each measured step, as JSON, written to the results file as it comes. */
const results = new Map<string, string>([
  ["workspaceId", JSON.stringify(workspaceId)],
]);

function note(key: string, json: string) {
  results.set(key, json);
}

async function load() {
  const client = new PGlite();
  databases.push(client);
  const directory = new URL("../../db/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- Migrations run in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The run swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  const scope = await import("@db/services/scope");
  await scope.ensureScope({ userId, workspaceId });
  return {
    cdp: await import("@agent/lib/browser-use/cdp"),
    cloud: await import("@agent/lib/browser-vm/cloudru"),
    host: await import("@agent/lib/browser-pool/host"),
    hosts: await import("@db/services/browser-hosts"),
    keys: await import("@agent/lib/browser-pool/keys"),
    lifecycle: await import("@agent/lib/browser-vm/lifecycle"),
    s3: await import("@agent/lib/browser-pool/s3"),
    vms: await import("@db/services/browser-vms"),
    worker: await import("@agent/lib/browser-vm/worker"),
  };
}

type Bro = Awaited<ReturnType<typeof load>>;
type Vm = NonNullable<Awaited<ReturnType<Bro["vms"]["readBrowserVm"]>>>;

let bro: Bro | undefined;

function need() {
  if (bro === undefined) throw new Error("Bro is not loaded yet.");
  return bro;
}

const seconds = (ms: number) => Math.round(ms / 10) / 100;
const sleep = async (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function log(message: string, json = "") {
  console.log(`[e2e] ${new Date().toISOString()} ${message} ${json}`);
}

function percentile(values: readonly number[], share: number) {
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(share * sorted.length) - 1
  );
  return sorted[Math.max(index, 0)] ?? Number.NaN;
}

/**
 * An errand's wait for its browser, as the queue does it: ensure, and while
 * the answer is "starting", the poller's reconcile and ensure again. The
 * poller runs once a minute; here it runs every `pollMs`, to time the steps.
 */
/**
 * How the hosts went, as the records say: each state a host reached, when
 * (seconds since the run began), and what Bro wrote of it.
 */
const hostTimeline: {
  at: number;
  error: string | null;
  host: string;
  rebooted: boolean;
  state: string;
}[] = [];
const runStarted = performance.now();

async function followHosts() {
  for (const row of await need().hosts.listBrowserHosts()) {
    const last = hostTimeline.findLast((entry) => entry.host === row.id);
    if (
      last?.state === row.state &&
      last.rebooted === (row.rebootedAt !== null)
    ) {
      continue;
    }
    hostTimeline.push({
      at: seconds(performance.now() - runStarted),
      error: row.lastError,
      host: row.id,
      rebooted: row.rebootedAt !== null,
      state: row.state,
    });
  }
}

async function ensureReady(pollMs = 10_000, budgetMs = 20 * 60_000) {
  const { lifecycle } = need();
  const started = performance.now();
  let attempts = 0;
  while (performance.now() - started < budgetMs) {
    attempts += 1;
    // oxlint-disable-next-line eslint/no-await-in-loop -- The errand asks again after each wait.
    const answer = await lifecycle.ensureBrowserVm(workspaceId, new Date());
    if (answer.kind === "ready") {
      return { attempts, ms: performance.now() - started, vm: answer.vm };
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await sleep(Math.min(answer.retryAfterMs, pollMs));
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await lifecycle.reconcileBrowserVms(new Date());
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await followHosts();
  }
  throw new Error("The sandbox did not come up in time.");
}

/** Bro's worker client until the worker is set up and Chrome answers. */
async function workerReady(vm: Vm, budgetMs = 120_000) {
  const { worker } = need();
  const started = performance.now();
  let last: unknown;
  while (performance.now() - started < budgetMs) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polled until it answers.
      const health = await worker.readBrowserVmWorkerHealth(vm);
      last = health;
      if (health.configured && health.chrome) {
        return { health, ms: performance.now() - started };
      }
    } catch (error) {
      last = String(error);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await sleep(250);
  }
  throw new Error(`The worker did not come up: ${JSON.stringify(last)}`);
}

const replySchema = z.object({
  error: z.json().optional(),
  id: z.number().optional(),
  result: z.json().optional(),
});
const targetsSchema = z.array(
  z.object({ id: z.string(), webSocketDebuggerUrl: z.string().optional() })
);
const cookiesSchema = z.object({
  cookies: z.array(z.object({ name: z.string(), value: z.string() })),
});
const evaluatedSchema = z.object({
  result: z.object({ value: z.string() }),
});

/** One CDP command on a page socket (the global WebSocket, as Bro's client). */
async function cdpCommand(
  socketUrl: string,
  method: string,
  params: Readonly<
    Record<string, boolean | number | string | readonly string[]>
  > = {}
) {
  const socket = new WebSocket(socketUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        resolve();
      });
      socket.addEventListener("error", () => {
        reject(new Error(`CDP socket failed for ${method}`));
      });
    });
    return await new Promise<z.infer<typeof replySchema>["result"]>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`CDP ${method} timed out`));
        }, 30_000);
        socket.addEventListener("message", (event) => {
          const message = replySchema.parse(JSON.parse(String(event.data)));
          if (message.id !== 1) return;
          clearTimeout(timer);
          if (message.error === undefined) resolve(message.result);
          else reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        });
        socket.send(JSON.stringify({ id: 1, method, params }));
      }
    );
  } finally {
    socket.close();
  }
}

/**
 * A keep-alive tab of the worker's (Bro's client), reached through the
 * host's Caddy under `/g/<sandbox>/` with a token scoped to that tab.
 */
async function withTab<T>(vm: Vm, act: (socket: string) => Promise<T>) {
  const { worker } = need();
  const targetId = await worker.openBrowserVmWorkerTab(vm);
  try {
    const base = worker
      .browserVmCdpUrl(vm, { targetId })
      .replace(/^wss:/u, "https:");
    const listing = await fetch(`${base}/json`);
    const targets = targetsSchema.parse(await listing.json());
    const socket = targets.find(
      (target) => target.id === targetId
    )?.webSocketDebuggerUrl;
    if (socket === undefined) throw new Error("The tab is not listed.");
    if (!socket.includes(`/g/${need().keys.browserSandboxId(workspaceId)}/`)) {
      throw new Error(`The socket misses the host prefix: ${socket}`);
    }
    return await act(socket);
  } finally {
    await worker.closeBrowserVmWorkerTab(vm, targetId).catch(() => undefined);
  }
}

const markerUrl = "https://example.com/";

async function setMarker(vm: Vm, marker: string, name = "bro_marker") {
  await withTab(vm, async (socket) =>
    cdpCommand(socket, "Network.setCookie", {
      expires: Math.floor(Date.now() / 1000) + 7 * 86_400,
      name,
      url: markerUrl,
      value: marker,
    })
  );
}

async function readMarker(vm: Vm, name = "bro_marker") {
  return withTab(vm, async (socket) => {
    const { cookies } = cookiesSchema.parse(
      await cdpCommand(socket, "Network.getCookies", { urls: [markerUrl] })
    );
    return cookies.find((cookie) => cookie.name === name)?.value;
  });
}

/** What `chrome://sandbox` says about Chrome's own sandbox in the sandbox. */
async function chromeSandboxPage(vm: Vm) {
  return withTab(vm, async (socket) => {
    await cdpCommand(socket, "Page.navigate", { url: "chrome://sandbox" });
    await sleep(1500);
    const { result } = evaluatedSchema.parse(
      await cdpCommand(socket, "Runtime.evaluate", {
        expression: "document.body.innerText",
        returnByValue: true,
      })
    );
    return result.value;
  });
}

/** The sandboxes a host holds of this workspace, by `hostd`'s capacity. */
async function heldOnHosts() {
  const { host, hosts, keys } = need();
  const id = keys.browserSandboxId(workspaceId);
  const held: { generation: number; host: string; state: string }[] = [];
  for (const row of await hosts.listBrowserHosts()) {
    if (row.address === null) continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- One host at a time.
    const capacity = await host.readBrowserHostCapacity(row).catch(() => null);
    for (const sandbox of capacity?.sandboxes ?? []) {
      if (sandbox.id === id) {
        held.push({
          generation: sandbox.generation,
          host: row.id,
          state: sandbox.state,
        });
      }
    }
  }
  return held;
}

/** No sandbox of the workspace lives twice: at most one, not parked. */
async function expectOneSandbox(label: string) {
  const live = (await heldOnHosts()).filter(
    (sandbox) => sandbox.state !== "parked"
  );
  log(`sandboxes on hosts ${label}`, JSON.stringify(live));
  expect(live.length).toBeLessThanOrEqual(1);
  return live;
}

/**
 * The stand's console on the host (`BROWSER_POOL_E2E_CONSOLE=1`): what
 * `pool_inspect.sh` shows of the sandbox — Chrome's own sandbox, seccomp,
 * the mounts — its runtime.log, and the profile's mount.
 */
function inspectOnHost(vmName: string, label: string) {
  if (!consoleAccess) return "";
  const run = (args: readonly string[]) =>
    spawnSync("python3", ["console.py", ...args], {
      cwd: probeDirectory,
      encoding: "utf8",
      timeout: 600_000,
    });
  run(["push", vmName, "vm/pool_inspect.sh", "/root/pool_inspect.sh"]);
  const id = need().keys.browserSandboxId(workspaceId);
  const directory = `/srv/bro/sandboxes/${id}`;
  const shown = run([
    "run",
    vmName,
    [
      `bash /root/pool_inspect.sh ${id} 2>&1 | tail -40`,
      `echo "== init seccomp $(awk '/^Seccomp:/ {print $2}' /proc/$(runc --root /run/runc-bro state bro-${id} | python3 -c 'import json,sys; print(json.load(sys.stdin)["pid"])')/status)"`,
      `echo "== profile $(findmnt -n -o SOURCE,FSTYPE,OPTIONS ${directory}/profile)"`,
      `echo "== log lines on sandbox or namespace trouble $(grep -c -i -E 'operation not permitted|no usable sandbox|namespace|seccomp' ${directory}/runtime.log)"`,
      `grep -a -E 'bro-sandbox-init|killed' ${directory}/runtime.log | tail -6`,
    ].join("; "),
    "--timeout",
    "300",
  ]);
  const text = `${shown.stdout}${shown.stderr}`.trim();
  log(`on the host (${label})`, `\n${text}`);
  return text;
}

async function save() {
  const entries: [string, string][] = [
    ...results,
    ["alerts", JSON.stringify(recorded.alerts)],
    ["starts", JSON.stringify(recorded.starts)],
    ["hostTimeline", JSON.stringify(hostTimeline)],
    ["parks", JSON.stringify(recorded.parks)],
  ];
  await writeFile(
    session.BROWSER_POOL_E2E_RESULTS,
    `{\n${entries.map(([key, json]) => ` ${JSON.stringify(key)}: ${json}`).join(",\n")}\n}\n`
  );
}

afterAll(async () => {
  try {
    await save();
    if (bro !== undefined) await cleanUp(bro);
  } finally {
    await Promise.all(
      recorded.passwords.map(async (file) => rm(file, { force: true }))
    );
    await Promise.all(databases.splice(0).map(async (db) => db.close()));
  }
});

/**
 * Whatever the run left, whether it passed or not: the workspace's sets,
 * and every host of the prefix on Cloud.ru with its public address.
 */
async function cleanUp({ cloud, hosts, keys, s3 }: Bro) {
  try {
    await s3.deleteBrowserStateObjects(
      `sets/${keys.browserSandboxId(workspaceId)}/`
    );
  } catch (error) {
    log("cleanup: the sets could not be deleted", String(error));
  }
  const names = new Set([
    ...(await hosts.listBrowserHosts()).map((row) => row.vmName),
    ...recorded.creates.map((create) => create.name),
    `${session.BROWSER_HOST_NAME_PREFIX}1`,
  ]);
  for (const name of names) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One VM at a time.
    const vm = await cloud.findCloudRuVmByName(name).catch(() => undefined);
    if (vm === undefined) continue;
    log(`cleanup: deleting ${name}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await cloud.deleteCloudRuVm(vm.id, {
      diskIds: [],
      floatingIpIds: vm.floatingIpId === undefined ? [] : [vm.floatingIpId],
    });
  }
}

/** The scenario the run picks (BROWSER_POOL_E2E_SCENARIO). */
const handoverRun = session.BROWSER_POOL_E2E_SCENARIO === "handover";

it.skipIf(handoverRun)("drives real hosts from Bro's own code", async () => {
  bro = await load();
  const { cloud, hosts, keys, lifecycle, s3, vms, worker } = bro;
  const sandboxId = keys.browserSandboxId(workspaceId);
  const marker = `m${randomBytes(4).toString("hex")}`;

  // 1. From absent: Bro creates a host from stock Ubuntu and starts the
  // sandbox on it.
  const absent = await ensureReady();
  const host = await hosts.readBrowserHost(absent.vm.hostId ?? "");
  const firstReady = await workerReady(absent.vm);
  note(
    "fromAbsent",
    JSON.stringify({
      attempts: absent.attempts,
      creates: recorded.creates,
      hostVm: host?.vmName,
      readyAt: Date.now(),
      seconds: seconds(absent.ms),
      workerSeconds: seconds(firstReady.ms),
    })
  );
  note("firstHealth", JSON.stringify(firstReady.health));
  log("from absent", results.get("fromAbsent"));
  await save();
  expect(absent.vm.sandboxState).toBe("running");
  expect(host?.vmName.startsWith(session.BROWSER_HOST_NAME_PREFIX)).toBe(true);
  await expectOneSandbox("after the first start");

  // 2. The worker and Chrome through the host's Caddy: Bro's own CDP client
  // over WebSocket under /g/<sandbox>/, Chrome's sandbox, a cookie marker.
  const shotTab = await worker.openBrowserVmWorkerTab(absent.vm);
  const shot = await bro.cdp.captureViewportOverCdp(
    worker.browserVmCdpUrl(absent.vm, { targetId: shotTab })
  );
  await worker.closeBrowserVmWorkerTab(absent.vm, shotTab);
  note("viewportBytes", String(JSON.stringify(shot).length));
  const sandboxPage = await chromeSandboxPage(absent.vm);
  note("chromeSandbox", JSON.stringify(sandboxPage));
  log("chrome://sandbox", JSON.stringify(sandboxPage));
  await setMarker(absent.vm, marker);
  const markedAt = performance.now();
  expect(await readMarker(absent.vm)).toBe(marker);
  note(
    "onHostFirst",
    JSON.stringify(inspectOnHost(host?.vmName ?? "", "first start"))
  );
  await save();

  // 3. Parks by the idle window (the reconcile a few minutes on) and starts
  // from parked, as an errand would, `cycles` times.
  // Chrome commits its cookie store every 30 s; a sign-in parks only after
  // the idle window, so the marker is given that long.
  await sleep(Math.max(0, 35_000 - (performance.now() - markedAt)));
  // A cookie set just before the park: SIGTERM alone lost it (Chrome ends
  // the session without writing its cookie store).
  const fresh = `f${randomBytes(4).toString("hex")}`;
  await setMarker(absent.vm, fresh, "bro_fresh");
  const fromParked: number[] = [];
  const workerAfter: number[] = [];
  let current = absent.vm;
  let freshSeen: string | undefined;
  for (let cycle = 1; cycle <= session.BROWSER_POOL_E2E_CYCLES; cycle += 1) {
    const idleOver = new Date(Date.now() + 4 * 60_000);
    // oxlint-disable-next-line eslint/no-await-in-loop -- The cycles run in order.
    await lifecycle.reconcileBrowserVms(idleOver);
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const parked = await vms.readBrowserVm(workspaceId);
    log(
      `cycle ${String(cycle)}: parked`,
      JSON.stringify({
        park: recorded.parks.at(-1),
        snapshotFormat: parked?.snapshotFormat,
        state: parked?.sandboxState,
      })
    );
    expect(parked?.sandboxState).toBe("parked");
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await expectOneSandbox(`after park ${String(cycle)}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const up = await ensureReady(2_000);
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const ready = await workerReady(up.vm);
    fromParked.push(up.ms + ready.ms);
    workerAfter.push(ready.ms);
    current = up.vm;
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const seen = await readMarker(current);
    if (cycle === 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Once, in the first cycle.
      freshSeen = await readMarker(current, "bro_fresh");
      note("freshCookieKept", JSON.stringify(freshSeen === fresh));
    }
    log(
      `cycle ${String(cycle)}: up`,
      JSON.stringify({
        ensureSeconds: seconds(up.ms),
        generation: current.generation,
        marker: seen,
        start: recorded.starts.at(-1),
        workerSeconds: seconds(ready.ms),
      })
    );
    expect(seen).toBe(marker);
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await expectOneSandbox(`after start ${String(cycle)}`);
  }
  note(
    "fromParked",
    JSON.stringify({
      p50: seconds(percentile(fromParked, 0.5)),
      p95: seconds(percentile(fromParked, 0.95)),
      seconds: fromParked.map(seconds),
      workerSeconds: workerAfter.map(seconds),
    })
  );
  log("from parked", results.get("fromParked"));
  note(
    "onHostAfterCycles",
    JSON.stringify(inspectOnHost(host?.vmName ?? "", "after the cycles"))
  );
  await save();
  expect(percentile(fromParked, 0.95)).toBeLessThan(15_000);
  // The worker closes Chrome through CDP before the host's SIGTERM.
  expect(freshSeen).toBe(fresh);

  // 4. The host's VM deleted behind Bro's back while the sandbox runs on
  // it: the watchdog takes the sandbox back to its last set (the last
  // cycle's park) and deletes the host, and the next errand gets a new host.
  const lost = await hosts.readBrowserHost(current.hostId ?? "");
  if (lost?.vmId === null || lost === undefined) throw new Error("No host.");
  const lossStarted = performance.now();
  await cloud.deleteCloudRuVm(lost.vmId, { diskIds: [], floatingIpIds: [] });
  log("host VM deleted behind Bro's back", lost.vmName);
  let parkedAfterMs = Number.NaN;
  while (performance.now() - lossStarted < 20 * 60_000) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The poller's minute, sped up.
    await lifecycle.reconcileBrowserVms(new Date());
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const [record, left] = await Promise.all([
      vms.readBrowserVm(workspaceId),
      hosts.listBrowserHosts(),
      followHosts(),
    ]);
    log(
      "watchdog",
      JSON.stringify({
        hosts: left.map((row) => `${row.id}:${row.state}`),
        sandbox: record?.sandboxState,
      })
    );
    if (record?.sandboxState === "parked" && Number.isNaN(parkedAfterMs)) {
      parkedAfterMs = performance.now() - lossStarted;
    }
    if (record?.sandboxState === "parked" && left.length === 0) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await sleep(15_000);
  }
  const hostGoneMs = performance.now() - lossStarted;
  expect(await hosts.listBrowserHosts()).toHaveLength(0);
  const afterLoss = await ensureReady();
  const newHost = await hosts.readBrowserHost(afterLoss.vm.hostId ?? "");
  const lossReady = await workerReady(afterLoss.vm);
  const kept = await readMarker(afterLoss.vm);
  note(
    "watchdog",
    JSON.stringify({
      hostGoneSeconds: seconds(hostGoneMs),
      marker: kept,
      newHost: newHost?.vmId,
      newHostSeconds: seconds(afterLoss.ms),
      oldHost: lost.vmId,
      parkedSeconds: seconds(parkedAfterMs),
      start: recorded.starts.at(-1),
      workerSeconds: seconds(lossReady.ms),
    })
  );
  log("after the host failure", results.get("watchdog"));
  await save();
  expect(newHost?.vmId).not.toBe(lost.vmId);
  expect(kept).toBe(marker);
  await expectOneSandbox("after the new host");
  note(
    "onHostAfterLoss",
    JSON.stringify(inspectOnHost(newHost?.vmName ?? "", "new host"))
  );

  // 5. The workspace deleted: the sandbox off its host, its sets gone.
  const deleted = await lifecycle.deleteBrowserVm(workspaceId, new Date());
  const setsLeft = await s3.listBrowserStateObjects(`sets/${sandboxId}/`);
  const heldAfter = await heldOnHosts();
  note(
    "deletion",
    JSON.stringify({ deleted, heldAfter, setsLeft: setsLeft.length })
  );
  log("deleted", results.get("deletion"));
  expect(deleted).toBe(true);
  expect(setsLeft).toHaveLength(0);
  expect(heldAfter).toHaveLength(0);
  expect(await vms.readBrowserVm(workspaceId)).toBeUndefined();

  // 6. The empty host drained and deleted by the watchdog, address and all,
  // its idle time (30 minutes here) passed.
  const later = Date.now() + 31 * 60_000;
  for (let round = 0; round < 30; round += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The poller's minute.
    await lifecycle.reconcileBrowserVms(new Date(later + round * 60_000));
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const left = await hosts.listBrowserHosts();
    log(
      "host removal",
      JSON.stringify(left.map((row) => `${row.id}:${row.state}`))
    );
    if (left.length === 0) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await sleep(15_000);
  }
  expect(await hosts.listBrowserHosts()).toHaveLength(0);
  await save();
});

/**
 * Stage 5's handover on real Cloud.ru: a record left naming a VM that is
 * gone (an id and a name Cloud.ru has never had, an address of the
 * documentation's). The first errand asks Cloud.ru for it by id and by
 * name, hands the record over, and goes on to a sandbox on a new host of
 * the probe's prefix; the workspace is then deleted with its sets, and the
 * host with its address goes in the cleanup.
 */
it.runIf(handoverRun)("hands a gone VM over to a sandbox", async () => {
  bro = await load();
  const { hosts, lifecycle, s3, vms } = bro;
  const sandboxId = bro.keys.browserSandboxId(workspaceId);
  const goneId = crypto.randomUUID();
  const goneName = `${session.BROWSER_HOST_NAME_PREFIX}gone-${randomBytes(4).toString("hex")}`;
  await vms.ensureBrowserVmRecord(workspaceId);
  const seeded = await vms.updateBrowserVm(
    workspaceId,
    {
      bootDiskId: crypto.randomUUID(),
      generation: 3,
      host: "203.0.113.7",
      image: "probe-image-gone",
      lastUsedAt: new Date(Date.now() - 3 * 86_400_000),
      state: "stopped",
      vmId: goneId,
      vmName: goneName,
    },
    new Date()
  );
  log("seeded a record naming a gone VM", JSON.stringify({ goneId, goneName }));

  const handed = await ensureReady();
  const host = await hosts.readBrowserHost(handed.vm.hostId ?? "");
  const ready = await workerReady(handed.vm);
  note(
    "handover",
    JSON.stringify({
      attempts: handed.attempts,
      creates: recorded.creates,
      hostVm: host?.vmName,
      record: {
        generation: handed.vm.generation,
        image: handed.vm.image,
        profileGeneration: handed.vm.profileGeneration,
        sandboxState: handed.vm.sandboxState,
        vmId: handed.vm.vmId,
        vmName: handed.vm.vmName,
      },
      seconds: seconds(handed.ms),
      workerSeconds: seconds(ready.ms),
    })
  );
  log("handed over", results.get("handover"));
  await save();
  expect(handed.vm).toMatchObject({
    bootDiskId: null,
    image: null,
    profileGeneration: seeded.profileGeneration + 1,
    sandboxState: "running",
    vmId: null,
    vmName: null,
  });
  expect(handed.vm.generation).toBeGreaterThan(seeded.generation);
  expect(host?.vmName.startsWith(session.BROWSER_HOST_NAME_PREFIX)).toBe(true);
  expect(recorded.alerts.map((alert) => alert.key)).not.toContain(
    `browser-pool-handover:${workspaceId}`
  );
  await expectOneSandbox("after the handover");

  const deleted = await lifecycle.deleteBrowserVm(workspaceId, new Date());
  const setsLeft = await s3.listBrowserStateObjects(`sets/${sandboxId}/`);
  note("deletion", JSON.stringify({ deleted, setsLeft: setsLeft.length }));
  await save();
  expect(deleted).toBe(true);
  expect(setsLeft).toHaveLength(0);
});
