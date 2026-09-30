/**
 * Bro's worker rollout (`agent/lib/browser-vm/rollout.ts`) end to end: a
 * workspace VM created by Bro's own lifecycle from a real image on Cloud.ru,
 * the published worker taken from Object Storage and pushed onto it by
 * `ensureBrowserVm` before an errand, then the new worker's routes and one
 * short real errand. No production and no web app: the database is PGlite
 * in memory, the signing key and the workspace are the run's own, and the
 * residential proxy is a plain HTTP proxy on the VM itself (the stand's
 * `vm/proxy.py`, so the exit is the VM's Cloud.ru address). Not part of
 * `pnpm check`: it creates a VM and spends model tokens. What it measured —
 * docs/browser-cloud-migration.md, section 13 (worker updates).
 *
 * Run it with the Cloud.ru keys and the model key of the session:
 *
 *   WORKER_ROLLOUT_E2E_WORKER=<version>:<key>:<sha256> \
 *   WORKER_ROLLOUT_E2E_IMAGE=bro-browser-2026-09-29-6 \
 *   BROWSER_STATE_BUCKET=<bucket> ROUTERAI_API_KEY=... \
 *   pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/worker-rollout.e2e.ts
 *
 * The object is published under a test key first (`publish.py --prefix
 * probe/workers/`). Stood in for: owner alerts are collected; the VM is
 * named `probe-roll` (not `bro-…`) and its user data also gets the stand
 * proxy and a root password for the serial console (`console.py`).
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as cloudRuModule from "@agent/lib/browser-vm/cloudru";
import type * as ownerAlert from "@agent/lib/owner-alert";
import * as schema from "@db/schema";

const sessionSchema = z.object({
  BROWSER_STATE_BUCKET: z.string().min(1),
  CLOUDRU_KEY_ID: z.string().min(1),
  CLOUDRU_KEY_SECRET: z.string().min(1),
  CLOUDRU_S3_TENANT_ID: z.string().min(1),
  PROBE_STATE_DIR: z.string().default(join(homedir(), ".bro-probe")),
  /** RouterAI, which answers Cloud.ru's addresses. */
  ROUTERAI_API_KEY: z.string().min(1),
  WORKER_ROLLOUT_E2E_IMAGE: z.string().min(1),
  WORKER_ROLLOUT_E2E_LOG: z
    .string()
    .default(join(tmpdir(), "worker-rollout-e2e.log")),
  WORKER_ROLLOUT_E2E_NAME: z
    .string()
    .regex(/^(?!bro-)[a-z][a-z\d-]*$/u, "not bro-…: Bro's own VMs")
    .default("probe-roll"),
  WORKER_ROLLOUT_E2E_WORKER: z.string().min(1),
});

// oxlint-disable-next-line eslint/no-restricted-properties -- The run reads the session's keys once, before any module validates its own settings.
const session = sessionSchema.parse(process.env);
const workspaceId = `e2e-roll-${randomBytes(6).toString("hex")}`;
const userId = `e2e-user-${randomBytes(6).toString("hex")}`;
const standProxyPort = 3130;

const recorded = vi.hoisted(() => {
  const alerts: { key: string; text: string }[] = [];
  return { alerts };
});

vi.mock("@agent/lib/owner-alert", () => ({
  alertOwner: vi.fn<typeof ownerAlert.alertOwner>(async (key, text) => {
    recorded.alerts.push({ key, text });
    console.log(`[e2e] owner alert ${key}: ${text.slice(0, 300)}`);
    return true;
  }),
}));

vi.mock("@agent/lib/browser-vm/cloudru", async (importOriginal) => {
  const original = await importOriginal<typeof cloudRuModule>();
  return {
    ...original,
    createCloudRuVm: async (
      input: Parameters<typeof original.createCloudRuVm>[0]
    ) => {
      const proxy = await readFile(
        new URL(
          "../../scripts/cloudru-sandbox-probe/vm/proxy.py",
          import.meta.url
        )
      );
      const password = `Pr${randomBytes(8).toString("hex")}9!`;
      await writeFile(
        join(
          session.PROBE_STATE_DIR,
          `${session.WORKER_ROLLOUT_E2E_NAME}.password`
        ),
        password,
        { mode: 0o600 }
      );
      // Bro's user data as it is, with the stand proxy's file and start
      // added to its own lists and the console login after them.
      const cloudInit = input.cloudInit.replace(
        "runcmd:\n",
        [
          "  - path: /root/proxy.py",
          "    encoding: b64",
          '    permissions: "0755"',
          `    content: ${proxy.toString("base64")}`,
          "runcmd:",
          `  - [bash, -c, 'nohup python3 /root/proxy.py ${String(standProxyPort)} >/dev/null 2>&1 &']`,
          "",
        ].join("\n")
      );
      return original.createCloudRuVm({
        cloudInit: `${cloudInit}chpasswd:\n  expire: false\n  users:\n    - {name: root, password: "${password}", type: text}\nssh_pwauth: false\n`,
        name: session.WORKER_ROLLOUT_E2E_NAME,
      });
    },
  };
});

const settings = {
  BETTER_AUTH_SECRET: randomBytes(24).toString("hex"),
  BETTER_AUTH_URL: "http://127.0.0.1:9",
  BROWSER_BACKEND: "",
  BROWSER_POOL_WORKSPACES: "",
  BROWSER_STATE_BUCKET: session.BROWSER_STATE_BUCKET,
  BROWSER_VM_LLM_API_KEY: session.ROUTERAI_API_KEY,
  BROWSER_VM_PROXY: `127.0.0.1:${String(standProxyPort)}:probe-{session}:none`,
  BROWSER_VM_SIGNING_KEY: randomBytes(32).toString("hex"),
  BROWSER_VM_WORKER: session.WORKER_ROLLOUT_E2E_WORKER,
  BROWSER_VM_WORKSPACES: workspaceId,
  CLOUDRU_BROWSER_IMAGE: session.WORKER_ROLLOUT_E2E_IMAGE,
  DATABASE_URL: "postgresql://e2e:e2e@127.0.0.1:9/e2e",
  TELEGRAM_OWNER_CHAT_ID: "",
};
for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);

async function load() {
  const client = new PGlite();
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
    backend: await import("@agent/lib/browser-vm/backend"),
    lifecycle: await import("@agent/lib/browser-vm/lifecycle"),
    vms: await import("@db/services/browser-vms"),
    worker: await import("@agent/lib/browser-vm/worker"),
  };
}

let bro: Awaited<ReturnType<typeof load>> | undefined;

const sleep = async (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const seconds = (ms: number) => Math.round(ms / 100) / 10;

/**
 * Each step, to the console and to the log file: vitest without a TTY prints
 * a test's output only when it fails.
 */
function log(message: string, json = "") {
  const line = `[e2e] ${new Date().toISOString()} ${message} ${json}`;
  console.log(line);
  appendFileSync(session.WORKER_ROLLOUT_E2E_LOG, `${line}\n`);
}

/** An errand's wait for its VM, with the poller's reconcile in between. */
async function ensureReady(budgetMs: number) {
  if (bro === undefined) throw new Error("Bro is not loaded.");
  const started = performance.now();
  while (performance.now() - started < budgetMs) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The errand asks again after each wait.
    const answer = await bro.lifecycle.ensureBrowserVm(workspaceId, new Date());
    if (answer.kind === "ready") {
      return { ms: performance.now() - started, vm: answer.vm };
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const row = await bro.vms.readBrowserVm(workspaceId);
    log(
      "waiting",
      JSON.stringify({
        error: row?.lastError ?? null,
        host: row?.host ?? null,
        recoveries: row?.recoveries,
        state: row?.state,
      })
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await sleep(Math.min(answer.retryAfterMs, 15_000));
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await bro.lifecycle.reconcileBrowserVms(new Date());
  }
  throw new Error("The VM did not come up in time.");
}

afterAll(async () => {
  if (bro === undefined) return;
  try {
    log(
      "deleting the VM",
      JSON.stringify(await bro.lifecycle.deleteBrowserVm(workspaceId))
    );
  } catch (error) {
    log("the VM was not deleted: delete it by hand", String(error));
  }
  log("owner alerts", JSON.stringify(recorded.alerts));
});

it("rolls the published worker out onto a VM of the image and runs an errand on it", async () => {
  bro = await load();
  const { backend, lifecycle, worker } = bro;
  const published = session.WORKER_ROLLOUT_E2E_WORKER.split(":")[0];

  const first = await ensureReady(20 * 60_000);
  const before = await worker.readBrowserVmWorkerHealth(first.vm);
  log(
    "ready on the image's worker",
    JSON.stringify({
      health: before,
      host: first.vm.host,
      s: seconds(first.ms),
    })
  );
  expect(before.worker).not.toBe(published);

  // An errand's VM is left alone for 90 s after it was handed out.
  await sleep(95_000);
  const rolled = await ensureReady(5 * 60_000);
  const after = await worker.readBrowserVmWorkerHealth(rolled.vm);
  log(
    "ready after the rollout",
    JSON.stringify({ health: after, s: seconds(rolled.ms) })
  );
  expect(after.worker).toBe(published);
  expect(after.configured && after.chrome).toBe(true);
  expect(rolled.vm.workerFailedVersion).toBeNull();

  log(
    "GET /v1/runs",
    JSON.stringify(await worker.listBrowserVmWorkerRuns(rolled.vm, "none"))
  );
  const restart = await worker.controlBrowserVmWorkerChrome(
    rolled.vm,
    "restart"
  );
  log("POST /v1/browser/restart", JSON.stringify(restart));
  expect(restart.chrome).toBe(true);
  await worker.parkBrowserVmWorker(rolled.vm);
  log("POST /v1/park answered");

  const routed = await lifecycle.prepareBrowserVmSession(rolled.vm, new Date());
  log("proxy exit", JSON.stringify(routed.proxyExit));

  const runId = `e2e-${randomBytes(6).toString("hex")}`;
  const started = performance.now();
  const start = await worker.startBrowserVmWorkerRun(routed, {
    id: runId,
    llm: backend.browserVmLlm(),
    maxSteps: 8,
    task: "Открой https://ru.wikipedia.org/wiki/Казань и найди в статье, в каком году впервые упоминается Казань. Ответь одной строкой: год.",
    timeoutSeconds: 300,
  });
  log("run started", JSON.stringify(start));
  let run = await worker.readBrowserVmWorkerRun(routed, runId);
  while (
    run !== undefined &&
    (run.status === "queued" || run.status === "running") &&
    performance.now() - started < 8 * 60_000
  ) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polled until the run ends.
    await sleep(3_000);
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    run = await worker.readBrowserVmWorkerRun(routed, runId);
  }
  const ended = performance.now();
  let idle = await worker.readBrowserVmWorkerHealth(routed);
  while (idle.busy && performance.now() - ended < 60_000) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polled until the worker lets the browser go.
    await sleep(1_000);
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    idle = await worker.readBrowserVmWorkerHealth(routed);
  }
  const lastStep = run?.steps.at(-1)?.at;
  log(
    "run",
    JSON.stringify({
      busyAfterEndS: seconds(performance.now() - ended),
      error: run?.error,
      finishedAt: run?.finishedAt,
      lastStepAt: lastStep,
      result: run?.result,
      s: seconds(ended - started),
      startedAt: run?.startedAt,
      status: run?.status,
      stepCount: run?.stepCount,
      success: run?.success,
      traffic: run?.traffic,
      usage: run?.usage,
    })
  );
  expect(run?.status).toBe("completed");
  expect(run?.result).toMatch(/\d{3,4}/u);
  expect(run?.usage).not.toBeNull();
  expect(idle.busy).toBe(false);
});
