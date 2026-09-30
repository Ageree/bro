import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ownerAlert from "@agent/lib/owner-alert";
import { z } from "zod";
import type * as lifecycleModule from "@agent/lib/browser-vm/lifecycle";
import type * as workerModule from "@agent/lib/browser-vm/worker";
import type { browserVmRuns, browserVms } from "@db/schema/browser-vms";
import type * as browserVmRecords from "@db/services/browser-vms";
import type * as usageCostRecords from "@db/services/usage-costs";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

type BrowserVmRow = typeof browserVms.$inferSelect;
type BrowserVmRunRow = typeof browserVmRuns.$inferSelect;
type WorkerRun = NonNullable<
  Awaited<ReturnType<typeof workerModule.readBrowserVmWorkerRun>>
>;

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const profileId = `vm:${workspaceId}:p1`;
const sessionId = `vm:${workspaceId}:s:5e7d2c1a-8b9f-4e3d-a2c1-0f9e8d7c6b5a`;
const runId = `vm:${workspaceId}:r:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d`;
const origin = "https://45-132-176-116.sslip.io";
const composedTask =
  "Errand: 7\nAttempt: 1\nFind the parcel on the courier site";
// What the VM's agent gets: the composed errand and the line that has it
// hand an address wall to the anti-bot retry at once.
const vmTask = `${composedTask}\n\nIf the site blocks this network address (for example «Доступ ограничен: проблема с IP»), call the solve_captcha action once: it gets past the site's check itself. If the wall is still there after it, or the check is of another kind, stop right away and end with NEEDS: captcha: Bro retries from another address. Do not keep solving it.`;

const claimsSchema = z.object({
  env: z.string(),
  exp: z.number(),
  gen: z.number(),
  ses: z.string().optional(),
});

const records = vi.hoisted(() => ({
  findBrowserVmRunByTaskLine:
    vi.fn<typeof browserVmRecords.findBrowserVmRunByTaskLine>(),
  readBrowserVm: vi.fn<typeof browserVmRecords.readBrowserVm>(),
  readBrowserVmRun: vi.fn<typeof browserVmRecords.readBrowserVmRun>(),
  recordBrowserVmRun: vi.fn<typeof browserVmRecords.recordBrowserVmRun>(),
  updateBrowserVm: vi.fn<typeof browserVmRecords.updateBrowserVm>(),
  updateBrowserVmRun: vi.fn<typeof browserVmRecords.updateBrowserVmRun>(),
}));

const lifecycle = vi.hoisted(() => ({
  ensureBrowserVm: vi.fn<typeof lifecycleModule.ensureBrowserVm>(),
  prepareBrowserVmSession:
    vi.fn<typeof lifecycleModule.prepareBrowserVmSession>(),
  touchBrowserVm: vi.fn<typeof lifecycleModule.touchBrowserVm>(),
}));

const worker = vi.hoisted(() => ({
  cancelBrowserVmWorkerRun:
    vi.fn<typeof workerModule.cancelBrowserVmWorkerRun>(),
  closeBrowserVmWorkerTab: vi.fn<typeof workerModule.closeBrowserVmWorkerTab>(),
  listBrowserVmWorkerFiles:
    vi.fn<typeof workerModule.listBrowserVmWorkerFiles>(),
  openBrowserVmWorkerTab: vi.fn<typeof workerModule.openBrowserVmWorkerTab>(),
  readBrowserVmWorkerRun: vi.fn<typeof workerModule.readBrowserVmWorkerRun>(),
  readBrowserVmWorkerSession:
    vi.fn<typeof workerModule.readBrowserVmWorkerSession>(),
  releaseBrowserVmWorkerSession:
    vi.fn<typeof workerModule.releaseBrowserVmWorkerSession>(),
  resetBrowserVmWorkerProfile:
    vi.fn<typeof workerModule.resetBrowserVmWorkerProfile>(),
  sendBrowserVmWorkerMessage:
    vi.fn<typeof workerModule.sendBrowserVmWorkerMessage>(),
  startBrowserVmWorkerRun: vi.fn<typeof workerModule.startBrowserVmWorkerRun>(),
}));

const alertOwner = vi.hoisted(() =>
  vi.fn<typeof ownerAlert.alertOwner>(() => Promise.resolve(true))
);

vi.mock("@agent/lib/owner-alert", () => ({ alertOwner }));
const recordUsageCost = vi.hoisted(() =>
  vi.fn<typeof usageCostRecords.recordUsageCost>()
);
vi.mock("@db/services/usage-costs", () => ({ recordUsageCost }));
vi.mock("@db/services/browser-vms", () => records);
vi.mock("@agent/lib/browser-vm/lifecycle", () => lifecycle);
vi.mock("@agent/lib/browser-vm/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof workerModule>()),
  ...worker,
}));

function vmRow(overrides: Partial<BrowserVmRow> = {}): BrowserVmRow {
  const now = new Date();
  return {
    bootDiskId: "disk-1",
    claimedAt: null,
    createdAt: new Date(now.getTime() - 86_400_000),
    floatingIpId: "fip-1",
    generation: 3,
    givenUpAt: null,
    healthFailures: 0,
    host: "45.132.176.116",
    hostId: null,
    image: "bro-browser-test-1",
    lastError: null,
    lastUsedAt: now,
    leaseUntil: null,
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
    vmName: "bro-personal0123456789ab-3",
    workspaceId,
    ...overrides,
  };
}

function runRecord(overrides: Partial<BrowserVmRunRow> = {}): BrowserVmRunRow {
  return {
    createdAt: new Date("2026-09-28T11:50:00.000Z"),
    error: null,
    finalUrl: null,
    finishedAt: null,
    id: runId,
    result: null,
    sessionId,
    status: "running",
    task: composedTask,
    unreadMessages: null,
    updatedAt: new Date("2026-09-28T11:55:00.000Z"),
    workspaceId,
    ...overrides,
  };
}

function workerRun(overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    createdAt: "2026-09-28T11:50:01Z",
    engine: "agent",
    error: null,
    finalTitle: null,
    finalUrl: null,
    finishedAt: null,
    id: runId,
    jev: null,
    result: null,
    sessionId,
    startedAt: "2026-09-28T11:50:02Z",
    status: "running",
    stepCount: 3,
    steps: [],
    success: null,
    task: "Find the parcel on the courier site",
    usage: null,
    ...overrides,
  };
}

/** The claims of the worker token a URL carries in its path. */
function claimsOf(url: string, before: string) {
  const token = url.split(before)[1]?.split("/")[0] ?? "";
  const payload = token.split(".")[1] ?? "";
  return claimsSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  );
}

beforeEach(() => {
  const vm = vmRow();
  records.readBrowserVm.mockResolvedValue(vm);
  records.readBrowserVmRun.mockResolvedValue(runRecord());
  records.recordBrowserVmRun.mockResolvedValue();
  records.updateBrowserVmRun.mockImplementation((id, patch) =>
    Promise.resolve(runRecord({ id, ...patch }))
  );
  records.updateBrowserVm.mockImplementation((id, patch) =>
    Promise.resolve(vmRow({ workspaceId: id, ...patch }))
  );
  lifecycle.ensureBrowserVm.mockResolvedValue({ kind: "ready", vm });
  lifecycle.prepareBrowserVmSession.mockImplementation((ready) =>
    Promise.resolve(ready)
  );
  lifecycle.touchBrowserVm.mockResolvedValue(vm);
  recordUsageCost.mockResolvedValue(true);
});

afterEach(() => {
  clearBrowserVmSettings();
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadClient() {
  return importWithSettings(
    browserVmTestEnvironment,
    async () => import("@agent/lib/browser-use/client")
  );
}

async function loadRuns() {
  return importWithSettings(
    browserVmTestEnvironment,
    async () => import("@agent/lib/browser-vm/runs")
  );
}

describe("starting a run on a workspace's browser VM", () => {
  it("asks the errand to wait, with the VM's own wait, while the VM starts", async () => {
    const client = await loadClient();
    lifecycle.ensureBrowserVm.mockResolvedValue({
      kind: "starting",
      retryAfterMs: 180_000,
    });

    const refused = await client
      .createBrowserUseRun({ profileId, task: composedTask })
      .catch((cause: unknown) => cause);

    expect(refused).toBeInstanceOf(client.BrowserUseError);
    expect(client.browserUseBusy(refused)).toBe(true);
    expect(refused).toMatchObject({ retryAfterMs: 180_000, status: 429 });
    expect(records.recordBrowserVmRun).not.toHaveBeenCalled();
    expect(worker.startBrowserVmWorkerRun).not.toHaveBeenCalled();
  });

  it("records the run before it starts it, on the VM's own model with the person's secrets", async () => {
    const client = await loadClient();
    worker.startBrowserVmWorkerRun.mockImplementation((_vm, input) =>
      Promise.resolve({
        id: input.id,
        sessionId: input.sessionId ?? "",
        status: "queued",
      })
    );

    const run = await client.createBrowserUseRun({
      customProxy: { host: "proxy.browser-use.test", port: 8080 },
      maxCostUsd: 2,
      model: "gpt-cloud",
      profileId,
      proxyCountryCode: "ru",
      secretBindings: [
        {
          alias: "phone",
          allowedDomains: ["ozon.ru"],
          source: { type: "inline", value: "9161234567" },
        },
      ],
      task: composedTask,
    });

    expect(run.id).toMatch(
      new RegExp(`^vm:${workspaceId}:r:[\\da-f-]{36}$`, "u")
    );
    expect(run.sessionId).toMatch(
      new RegExp(`^vm:${workspaceId}:s:[\\da-f-]{36}$`, "u")
    );
    expect(run).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      status: "queued",
    });
    // Recorded as on its way before the worker is asked, in the same
    // write, and as the worker has it once it answered.
    expect(records.recordBrowserVmRun).toHaveBeenCalledExactlyOnceWith({
      id: run.id,
      sessionId: run.sessionId,
      status: "dispatching",
      task: vmTask,
      workspaceId,
    });
    expect(
      records.recordBrowserVmRun.mock.invocationCallOrder[0] ?? Infinity
    ).toBeLessThan(
      worker.startBrowserVmWorkerRun.mock.invocationCallOrder[0] ?? 0
    );
    expect(
      records.updateBrowserVmRun.mock.calls.map(([id, patch]) => [
        id,
        patch.status,
      ])
    ).toEqual([[run.id, "queued"]]);
    expect(worker.startBrowserVmWorkerRun).toHaveBeenCalledOnce();
    expect(worker.startBrowserVmWorkerRun.mock.calls[0]?.[1]).toEqual({
      id: run.id,
      llm: {
        apiKey: "routerai-test-key",
        baseUrl: "https://routerai.ru/api/v1",
        model: "deepseek/deepseek-v4.1-flash",
      },
      maxSteps: 60,
      secrets: [
        { alias: "phone", allowedDomains: ["ozon.ru"], value: "9161234567" },
      ],
      sessionId: run.sessionId,
      task: vmTask,
      timeoutSeconds: 1500,
    });
  });

  it("gives the worker the 2Captcha key only when the deployment has one", async () => {
    worker.startBrowserVmWorkerRun.mockImplementation((_vm, input) =>
      Promise.resolve({
        id: input.id,
        sessionId: input.sessionId ?? "",
        status: "queued",
      })
    );
    const start = { profileId, task: composedTask };

    await (await loadClient()).createBrowserUseRun(start);
    vi.resetModules();
    const withKey = await importWithSettings(
      { ...browserVmTestEnvironment, BROWSER_VM_TWOCAPTCHA_API_KEY: "2c-key" },
      async () => import("@agent/lib/browser-use/client")
    );
    await withKey.createBrowserUseRun(start);

    const inputs = worker.startBrowserVmWorkerRun.mock.calls.map(
      ([, input]) => input.captcha
    );
    expect(inputs).toEqual([undefined, { twoCaptchaKey: "2c-key" }]);
  });

  it("keeps the errand's exit for a follow-up in its session, and may move a new errand's", async () => {
    const client = await loadClient();
    worker.startBrowserVmWorkerRun.mockImplementation((_vm, input) =>
      Promise.resolve({
        id: input.id,
        sessionId: input.sessionId ?? "",
        status: "queued",
      })
    );

    await client.createBrowserUseRun({ profileId, task: composedTask });
    await client.createBrowserUseRun({
      profileId,
      sessionId,
      task: composedTask,
    });

    expect(
      lifecycle.prepareBrowserVmSession.mock.calls.map(
        ([, , options]) => options
      )
    ).toEqual([{ rotate: true }, { rotate: false }]);
  });

  it("asks for a fresh exit, for an anti-bot retry's follow-up", async () => {
    const client = await loadClient();
    worker.startBrowserVmWorkerRun.mockImplementation((_vm, input) =>
      Promise.resolve({
        id: input.id,
        sessionId: input.sessionId ?? "",
        status: "queued",
      })
    );

    const run = await client.createBrowserUseRun({
      freshExit: true,
      profileId,
      sessionId,
      task: composedTask,
    });

    expect(records.recordBrowserVmRun).toHaveBeenCalledExactlyOnceWith({
      id: run.id,
      sessionId,
      status: "dispatching",
      task: vmTask,
      workspaceId,
    });
    expect(lifecycle.prepareBrowserVmSession).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.anything(),
      { freshExit: true, rotate: false }
    );
  });

  it("answers with the run the worker took though its record could not be written", async () => {
    const client = await loadClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    worker.startBrowserVmWorkerRun.mockImplementation((_vm, input) =>
      Promise.resolve({
        id: input.id,
        sessionId: input.sessionId ?? "",
        status: "running",
      })
    );
    records.updateBrowserVmRun.mockRejectedValue(
      new Error("connection terminated")
    );

    // The run acts for the person already: the caller must get it to track.
    const run = await client.createBrowserUseRun({
      profileId,
      task: composedTask,
    });

    expect(run).toMatchObject({ status: "running" });
    expect(worker.startBrowserVmWorkerRun).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("adopts a start whose answer was lost instead of sending it twice", async () => {
    const client = await loadClient();
    worker.startBrowserVmWorkerRun.mockRejectedValue(
      new TypeError("fetch failed")
    );
    worker.readBrowserVmWorkerRun.mockImplementation((_vm, id) =>
      Promise.resolve(workerRun({ id, sessionId }))
    );

    const run = await client.createBrowserUseRun({
      profileId,
      sessionId,
      task: composedTask,
    });

    expect(run.sessionId).toBe(sessionId);
    expect(run.status).toBe("running");
    expect(worker.startBrowserVmWorkerRun).toHaveBeenCalledOnce();
    expect(worker.readBrowserVmWorkerRun).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      run.id
    );
    expect(
      records.updateBrowserVmRun.mock.calls.map(([, patch]) => patch.status)
    ).toEqual(["running"]);
  });

  it("closes the record of a start the worker never got, and says it failed", async () => {
    const client = await loadClient();
    worker.startBrowserVmWorkerRun.mockRejectedValue(
      new TypeError("fetch failed")
    );
    worker.readBrowserVmWorkerRun.mockResolvedValue(undefined);

    await expect(
      client.createBrowserUseRun({ profileId, task: composedTask })
    ).rejects.toThrow("fetch failed");

    expect(worker.startBrowserVmWorkerRun).toHaveBeenCalledOnce();
    expect(records.updateBrowserVmRun.mock.calls[0]?.[1]).toMatchObject({
      status: "cancelled",
    });
  });

  it("leaves a start with no answer the worker could not be asked about as dispatching", async () => {
    const client = await loadClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    worker.startBrowserVmWorkerRun.mockRejectedValue(
      new TypeError("fetch failed")
    );
    worker.readBrowserVmWorkerRun.mockRejectedValue(
      new TypeError("fetch failed")
    );

    await expect(
      client.createBrowserUseRun({ profileId, task: composedTask })
    ).rejects.toThrow("fetch failed");

    // Nobody knows whether it landed: the record stays as it was written,
    // dispatching, and a later lookup asks the worker.
    expect(records.recordBrowserVmRun.mock.calls[0]?.[0].status).toBe(
      "dispatching"
    );
    expect(records.updateBrowserVmRun).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("answers 409 when the session's own run holds the browser, and 429 when another errand does", async () => {
    const client = await loadClient();
    const { BrowserVmWorkerError } =
      await import("@agent/lib/browser-vm/worker");
    const otherRunId = `vm:${workspaceId}:r:99999999-9999-4999-8999-999999999999`;
    worker.startBrowserVmWorkerRun.mockRejectedValue(
      new BrowserVmWorkerError(
        409,
        "/v1/runs",
        JSON.stringify({ error: "busy", runId: otherRunId })
      )
    );

    records.readBrowserVmRun.mockResolvedValue(
      runRecord({ id: otherRunId, sessionId })
    );
    const sameSession = await client
      .createBrowserUseRun({ profileId, sessionId, task: composedTask })
      .catch((cause: unknown) => cause);

    records.readBrowserVmRun.mockResolvedValue(
      runRecord({ id: otherRunId, sessionId: `vm:${workspaceId}:s:other` })
    );
    const otherErrand = await client
      .createBrowserUseRun({ profileId, sessionId, task: composedTask })
      .catch((cause: unknown) => cause);

    expect(sameSession).toMatchObject({ status: 409 });
    expect(otherErrand).toMatchObject({ retryAfterMs: 60_000, status: 429 });
    expect(records.readBrowserVmRun).toHaveBeenCalledWith(otherRunId);
    // Neither refused start ran, so no later lookup may adopt it.
    expect(
      records.updateBrowserVmRun.mock.calls.map(([, patch]) => patch.status)
    ).toEqual(["cancelled", "cancelled"]);
  });

  it("starts a follow-up of a Browser Use session in a VM session of its own", async () => {
    const client = await loadClient();

    const refused = await client
      .createBrowserUseRun({
        profileId,
        sessionId: "22222222-2222-4222-8222-222222222222",
        task: composedTask,
      })
      .catch((cause: unknown) => cause);

    expect(refused).toMatchObject({ status: 404 });
    expect(lifecycle.ensureBrowserVm).not.toHaveBeenCalled();
  });
});

describe("reading a VM run", () => {
  it("mirrors the worker's answer into the record and answers with the composed task", async () => {
    const client = await loadClient();
    worker.readBrowserVmWorkerRun.mockResolvedValue(
      workerRun({
        finalUrl: "https://courier.example/track",
        finishedAt: "2026-09-28T11:58:00Z",
        result: "RESULT: the parcel is in Moscow",
        status: "completed",
      })
    );

    const run = await client.readBrowserUseRun(runId);

    expect(run).toEqual({
      createdAt: "2026-09-28T11:50:01Z",
      error: null,
      id: runId,
      result: "RESULT: the parcel is in Moscow",
      sessionId,
      status: "completed",
      task: composedTask,
      unreadMessages: [],
      workspaceId: sessionId,
    });
    expect(records.updateBrowserVmRun).toHaveBeenCalledOnce();
    expect(records.updateBrowserVmRun.mock.calls[0]?.[1]).toEqual({
      error: null,
      finalUrl: "https://courier.example/track",
      finishedAt: new Date("2026-09-28T11:58:00Z"),
      result: "RESULT: the parcel is in Moscow",
      status: "completed",
      unreadMessages: [],
    });
  });

  it("records what a settled run spent on its model and its proxy, keyed by the run", async () => {
    const client = await loadClient();
    worker.readBrowserVmWorkerRun.mockResolvedValue(
      workerRun({
        finishedAt: "2026-09-28T11:58:00Z",
        result: "RESULT: the parcel is in Moscow",
        status: "completed",
        traffic: { down: 9_000_000, up: 1_000_000 },
        usage: {
          total_completion_tokens: 2_000,
          total_cost: 0.02,
          total_prompt_cached_tokens: 50_000,
          total_prompt_tokens: 150_000,
          total_tokens: 152_000,
        },
      })
    );

    await client.readBrowserUseRun(runId);
    await client.readBrowserUseRun(runId);

    const finishedAt = new Date("2026-09-28T11:58:00Z");
    expect(recordUsageCost).toHaveBeenCalledWith({
      // 100k fresh × 9.66 + 50k cached × 1.21 + 2k out × 48.28 per million.
      costRub: 1.12306,
      costUsd: null,
      idempotencyKey: `browser-run:${runId}`,
      occurredAt: finishedAt,
      runId,
      sessionId,
      source: "browser-run",
      units: {
        cachedInputTokens: 50_000,
        inputTokens: 150_000,
        model: "deepseek/deepseek-v4.1-flash",
        outputTokens: 2_000,
        steps: 3,
        unpriced: false,
      },
      workspaceId,
    });
    expect(recordUsageCost).toHaveBeenCalledWith({
      // 10 MB at the default 23 ₽ a gigabyte.
      costRub: 0.23,
      costUsd: null,
      idempotencyKey: `proxy:${runId}`,
      occurredAt: finishedAt,
      runId,
      sessionId,
      source: "proxy",
      units: { bytes: 10_000_000 },
      workspaceId,
    });
  });

  it("records nothing for a run still going, and never fails a read on the accounting", async () => {
    const client = await loadClient();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    worker.readBrowserVmWorkerRun.mockResolvedValueOnce(workerRun());
    await client.readBrowserUseRun(runId);
    expect(recordUsageCost).not.toHaveBeenCalled();

    recordUsageCost.mockRejectedValue(new Error("database is down"));
    worker.readBrowserVmWorkerRun.mockResolvedValue(
      workerRun({
        finishedAt: "2026-09-28T11:58:00Z",
        result: "RESULT: done",
        status: "completed",
        traffic: { down: 10, up: 10 },
      })
    );
    const run = await client.readBrowserUseRun(runId);
    expect(run.status).toBe("completed");
  });

  it("leaves a run the record already settled alone, and still records one a cancel closed", async () => {
    const client = await loadClient();
    const settled = workerRun({
      finishedAt: "2026-09-28T11:58:00Z",
      result: "RESULT: done",
      status: "completed",
      traffic: { down: 10, up: 10 },
    });
    records.readBrowserVmRun.mockResolvedValue(
      runRecord({ result: "RESULT: done", status: "completed" })
    );
    worker.readBrowserVmWorkerRun.mockResolvedValue(settled);

    await client.readBrowserUseRun(runId);

    expect(recordUsageCost).not.toHaveBeenCalled();

    records.readBrowserVmRun.mockResolvedValue(
      runRecord({ status: "cancelled" })
    );
    worker.readBrowserVmWorkerRun.mockResolvedValue({
      ...settled,
      status: "cancelled",
    });

    await client.readBrowserUseRun(runId);

    expect(recordUsageCost).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `proxy:${runId}` })
    );
  });

  it("marks a run on a model with no price as unpriced", async () => {
    const client = await importWithSettings(
      { ...browserVmTestEnvironment, BROWSER_VM_MODEL: "someone/unknown" },
      async () => import("@agent/lib/browser-use/client")
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    worker.readBrowserVmWorkerRun.mockResolvedValue(
      workerRun({
        finishedAt: "2026-09-28T11:58:00Z",
        status: "completed",
        usage: { total_completion_tokens: 10, total_prompt_tokens: 100 },
      })
    );

    await client.readBrowserUseRun(runId);

    expect(warn).toHaveBeenCalledWith(
      "[usage-costs] no price for the VM model",
      {
        model: "someone/unknown",
      }
    );
    expect(recordUsageCost).toHaveBeenCalledWith(
      expect.objectContaining({
        costRub: 0,
        idempotencyKey: `browser-run:${runId}`,
      })
    );
    expect(recordUsageCost.mock.calls[0]?.[0].units?.unpriced).toBe(true);
  });

  it("tells a run its model refused for billing as such, and alerts the owner", async () => {
    const client = await loadClient();
    worker.readBrowserVmWorkerRun.mockResolvedValue(
      workerRun({
        error: "Error code: 402 - {'error': 'Insufficient balance'}",
        finishedAt: "2026-09-28T11:58:00Z",
        status: "failed",
      })
    );

    const run = await client.readBrowserUseRun(runId);

    // Not the raw 402, which Bro's model read as the cloud browser's credits.
    expect(run.error).toMatch(/^Nothing was done on the site: the AI model/u);
    expect(run.error).toContain("only the service owner can fix");
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      "browser-vm-model-balance",
      expect.stringContaining("RouterAI"),
      { repeatAfterMs: 6 * 60 * 60_000 }
    );
  });

  it("surfaces messages the run ended without reading, and persists them", async () => {
    const client = await loadClient();
    worker.readBrowserVmWorkerRun.mockResolvedValue(
      workerRun({
        finishedAt: "2026-09-28T11:58:00Z",
        status: "completed",
        unreadMessages: ["и с завтраком"],
      })
    );

    const run = await client.readBrowserUseRun(runId);

    expect(run).toMatchObject({
      status: "completed",
      unreadMessages: ["и с завтраком"],
    });
    expect(records.updateBrowserVmRun.mock.calls[0]?.[1]).toMatchObject({
      status: "completed",
      unreadMessages: ["и с завтраком"],
    });
  });

  it("answers [] for unread messages once the worker no longer reports any", async () => {
    const client = await loadClient();
    worker.readBrowserVmWorkerRun.mockResolvedValue(
      workerRun({ status: "running" })
    );

    const run = await client.readBrowserUseRun(runId);

    expect(run).toMatchObject({ unreadMessages: [] });
  });

  it("marks a run failed once the VM it ran on is stopped", async () => {
    const client = await loadClient();
    records.readBrowserVm.mockResolvedValue(vmRow({ state: "stopped" }));

    const status = await client.readBrowserUseRunStatus(runId);
    const run = await client.readBrowserUseRun(runId);

    expect(status).toBe("failed");
    expect(run).toMatchObject({
      error: "The browser VM stopped before the run finished.",
      status: "failed",
      task: composedTask,
      workspaceId: sessionId,
    });
    expect(worker.readBrowserVmWorkerRun).not.toHaveBeenCalled();
    expect(records.updateBrowserVmRun.mock.calls[0]?.[1]).toMatchObject({
      error: "The browser VM stopped before the run finished.",
      status: "failed",
    });
  });

  it("marks a run failed when the worker that is up no longer has it", async () => {
    const client = await loadClient();
    worker.readBrowserVmWorkerRun.mockResolvedValue(undefined);

    const run = await client.readBrowserUseRun(runId);

    expect(run.status).toBe("failed");
  });

  it("keeps a run open while its VM is only unreachable", async () => {
    const client = await loadClient();
    worker.readBrowserVmWorkerRun.mockRejectedValue(
      new TypeError("fetch failed")
    );

    const run = await client.readBrowserUseRun(runId);

    expect(run.status).toBe("running");
    expect(records.updateBrowserVmRun).not.toHaveBeenCalled();
  });

  it("finds a start that lost its answer by its task line in Bro's own record", async () => {
    const client = await loadClient();
    records.findBrowserVmRunByTaskLine.mockResolvedValue(runRecord());

    const found = await client.findRecentBrowserUseRunByTaskLine(
      "Errand: 7",
      3,
      undefined,
      profileId
    );

    expect(found).toMatchObject({ id: runId, sessionId, task: composedTask });
    expect(records.findBrowserVmRunByTaskLine).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      "Errand: 7"
    );
    // A run the worker took is not asked about again.
    expect(worker.readBrowserVmWorkerRun).not.toHaveBeenCalled();
  });

  it("asks the worker about a start still dispatching before adopting it", async () => {
    const client = await loadClient();
    const find = async () =>
      client.findRecentBrowserUseRunByTaskLine(
        "Errand: 7",
        3,
        undefined,
        profileId
      );
    records.findBrowserVmRunByTaskLine.mockResolvedValue(
      runRecord({ status: "dispatching" })
    );

    // It landed: adopted, with what the worker says of it.
    worker.readBrowserVmWorkerRun.mockResolvedValueOnce(workerRun());
    expect(await find()).toMatchObject({ id: runId, status: "running" });
    expect(records.updateBrowserVmRun.mock.calls[0]?.[1]).toMatchObject({
      status: "running",
    });

    // It never did: closed, so the errand is started afresh.
    records.updateBrowserVmRun.mockClear();
    worker.readBrowserVmWorkerRun.mockResolvedValueOnce(undefined);
    expect(await find()).toBeUndefined();
    expect(records.updateBrowserVmRun).toHaveBeenCalledExactlyOnceWith(runId, {
      error: "The browser VM worker did not take the run.",
      status: "cancelled",
    });

    // Nobody answered: the caller tries again later, and nothing changes.
    records.updateBrowserVmRun.mockClear();
    worker.readBrowserVmWorkerRun.mockRejectedValueOnce(
      new TypeError("fetch failed")
    );
    await expect(find()).rejects.toThrow("fetch failed");
    expect(records.updateBrowserVmRun).not.toHaveBeenCalled();

    // A VM that is off has nobody to ask: the record is adopted as it is.
    records.readBrowserVm.mockResolvedValue(vmRow({ state: "stopped" }));
    worker.readBrowserVmWorkerRun.mockClear();
    expect(await find()).toMatchObject({ id: runId, status: "dispatching" });
    expect(worker.readBrowserVmWorkerRun).not.toHaveBeenCalled();
  });
});

describe("cancelling a VM run", () => {
  it("closes the record of a run whose stop the worker took, and says it is still on its step", async () => {
    const client = await loadClient();
    // The worker waited its 20 s and the agent is still on its step.
    worker.cancelBrowserVmWorkerRun.mockResolvedValue(workerRun());

    const run = await client.cancelBrowserUseRun(runId);

    expect(worker.cancelBrowserVmWorkerRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ host: "45.132.176.116" }),
      runId
    );
    expect(records.updateBrowserVmRun).toHaveBeenCalledOnce();
    const [closed, patch] = records.updateBrowserVmRun.mock.calls[0] ?? [];
    expect(closed).toBe(runId);
    expect(patch?.status).toBe("cancelled");
    expect(patch?.finishedAt).toBeInstanceOf(Date);
    // The VM's one browser is not free yet: a follow-up in the session
    // must wait for it rather than take the run as ended.
    expect(run.status).toBe("running");
  });

  it("answers a run the worker stopped within its wait as ended", async () => {
    const client = await loadClient();
    worker.cancelBrowserVmWorkerRun.mockResolvedValue(
      workerRun({
        error: "Stopped by Bro.",
        finishedAt: "2026-09-28T11:58:00Z",
        status: "cancelled",
      })
    );

    const run = await client.cancelBrowserUseRun(runId);

    expect(run.status).toBe("cancelled");
    expect(records.updateBrowserVmRun.mock.calls[0]?.[1]).toMatchObject({
      error: "Stopped by Bro.",
      status: "cancelled",
    });
  });

  it("asks the worker of a VM that is not marked ready, and fails when it does not answer", async () => {
    const client = await loadClient();
    records.readBrowserVm.mockResolvedValue(vmRow({ state: "starting" }));
    worker.cancelBrowserVmWorkerRun.mockRejectedValue(
      new TypeError("fetch failed")
    );

    await expect(client.cancelBrowserUseRun(runId)).rejects.toThrow(
      "fetch failed"
    );

    // The run may still be acting: it is not recorded as cancelled.
    expect(worker.cancelBrowserVmWorkerRun).toHaveBeenCalledOnce();
    expect(records.updateBrowserVmRun).not.toHaveBeenCalled();
  });

  it("closes the record alone on a VM that is off, or for a run the worker never had", async () => {
    const client = await loadClient();
    const { BrowserVmWorkerError } =
      await import("@agent/lib/browser-vm/worker");

    records.readBrowserVm.mockResolvedValueOnce(vmRow({ state: "stopped" }));
    const vmOff = await client.cancelBrowserUseRun(runId);
    worker.cancelBrowserVmWorkerRun.mockRejectedValueOnce(
      new BrowserVmWorkerError(404, "/v1/runs/x/cancel", "no such run")
    );
    const unknown = await client.cancelBrowserUseRun(runId);

    expect([vmOff.status, unknown.status]).toEqual(["cancelled", "cancelled"]);
    expect(worker.cancelBrowserVmWorkerRun).toHaveBeenCalledOnce();
    expect(
      records.updateBrowserVmRun.mock.calls.map(([, patch]) => patch.status)
    ).toEqual(["cancelled", "cancelled"]);
  });

  it("keeps what the worker says of a run that had already ended", async () => {
    const client = await loadClient();
    worker.cancelBrowserVmWorkerRun.mockResolvedValue(
      workerRun({
        finishedAt: "2026-09-28T11:58:00Z",
        result: "RESULT: done",
        status: "completed",
      })
    );

    const run = await client.cancelBrowserUseRun(runId);

    expect(run.status).toBe("completed");
    expect(records.updateBrowserVmRun.mock.calls[0]?.[1]).toMatchObject({
      status: "completed",
    });
  });
});

describe("a VM session's browser", () => {
  it("stops the session's tab only once its settled run is still the latest and done", async () => {
    const client = await loadClient();
    const stop = async () =>
      client.stopBrowserUseSessionBrowsers(sessionId, runId);
    const session = {
      id: sessionId,
      latestRunId: runId,
      status: "idle" as const,
      tabOpen: true,
    };

    records.readBrowserVm.mockResolvedValueOnce(vmRow({ state: "stopped" }));
    const vmOff = await stop();
    worker.readBrowserVmWorkerSession.mockResolvedValueOnce(undefined);
    const unknown = await stop();
    worker.readBrowserVmWorkerSession.mockResolvedValueOnce({
      ...session,
      latestRunId: `vm:${workspaceId}:r:later`,
    });
    const movedOn = await stop();
    worker.readBrowserVmWorkerSession.mockResolvedValueOnce({
      ...session,
      status: "running",
    });
    const running = await stop();
    worker.readBrowserVmWorkerSession.mockResolvedValueOnce(session);
    worker.releaseBrowserVmWorkerSession.mockResolvedValueOnce("stopped");
    const released = await stop();

    expect([vmOff, unknown, movedOn, running, released]).toEqual([
      "stopped",
      "stopped",
      "moved_on",
      "running",
      "stopped",
    ]);
    expect(worker.releaseBrowserVmWorkerSession).toHaveBeenCalledOnce();
  });

  it("gives the debugger endpoint of the session's tab, scoped to that session", async () => {
    const client = await loadClient();
    worker.readBrowserVmWorkerSession.mockResolvedValue({
      id: sessionId,
      latestRunId: runId,
      status: "idle",
      tabOpen: true,
    });

    const cdpUrl = await client.findBrowserUseSessionCdpUrl(sessionId);

    expect(cdpUrl).toMatch(
      /^wss:\/\/45-132-176-116\.sslip\.io\/v1\/cdp\/v1\./u
    );
    expect(claimsOf(cdpUrl ?? "", "/v1/cdp/")).toMatchObject({
      env: workspaceId,
      gen: 3,
      ses: sessionId,
    });

    worker.readBrowserVmWorkerSession.mockResolvedValue({
      id: sessionId,
      latestRunId: runId,
      status: "idle",
      tabOpen: false,
    });
    expect(await client.findBrowserUseSessionCdpUrl(sessionId)).toBeUndefined();
  });

  it("opens a keep-alive tab only on a VM that is already up", async () => {
    const client = await loadClient();
    const input = {
      customProxy: undefined,
      profileId,
      proxyCountryCode: "ru",
      timeoutMinutes: 5,
    };
    worker.openBrowserVmWorkerTab.mockResolvedValue("A1B2C3D4E5F6");

    const browser = await client.createBrowserUseBrowser(input);
    await client.stopBrowserUseBrowser(browser.id);

    expect(browser.id).toBe(`vm:${workspaceId}:b:A1B2C3D4E5F6`);
    expect(claimsOf(browser.cdpUrl, "/v1/cdp/").ses).toBe("b:A1B2C3D4E5F6");
    expect(worker.closeBrowserVmWorkerTab).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "A1B2C3D4E5F6"
    );
    // A keep-alive visit continues the workspace's one profile like a
    // follow-up run: it must not itself rotate the exit the sign-in it is
    // refreshing was checked from.
    expect(lifecycle.prepareBrowserVmSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId }),
      expect.any(Date),
      { rotate: false }
    );

    records.readBrowserVm.mockResolvedValue(vmRow({ state: "stopped" }));
    const refused = await client
      .createBrowserUseBrowser(input)
      .catch((cause: unknown) => cause);
    expect(client.browserUseBusy(refused)).toBe(true);
    expect(lifecycle.ensureBrowserVm).not.toHaveBeenCalled();
  });

  it("lists the files a session saved with download links scoped to it", async () => {
    const client = await loadClient();
    worker.listBrowserVmWorkerFiles.mockResolvedValue([
      {
        lastModified: "2026-09-28T11:57:00Z",
        path: "report/item 1.jpg",
        size: 2048,
      },
    ]);
    const before = Math.floor(Date.now() / 1_000);

    const listed = await client.listBrowserUseWorkspaceFiles(
      sessionId,
      "report/"
    );

    const [file] = listed.files;
    expect(file).toMatchObject({
      lastModified: "2026-09-28T11:57:00Z",
      path: "report/item 1.jpg",
      size: 2048,
    });
    const url = file?.url ?? "";
    expect(url.startsWith(`${origin}/v1/dl/v1.`)).toBe(true);
    expect(
      url.endsWith(`/${encodeURIComponent(sessionId)}/report/item%201.jpg`)
    ).toBe(true);
    const claims = claimsOf(url, "/v1/dl/");
    expect(claims.ses).toBe(sessionId);
    expect(claims.exp - before).toBeGreaterThanOrEqual(119);
    expect(claims.exp - before).toBeLessThanOrEqual(121);
    expect(worker.listBrowserVmWorkerFiles).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      sessionId,
      "report/"
    );

    records.readBrowserVm.mockResolvedValue(vmRow({ state: "stopped" }));
    expect(
      await client.listBrowserUseWorkspaceFiles(sessionId, "report/")
    ).toEqual({ files: [] });
  });

  it("queues a message into the session as a recorded follow-up, and refuses one while the VM is off", async () => {
    const client = await loadClient();
    worker.sendBrowserVmWorkerMessage.mockImplementation((_vm, id, message) =>
      Promise.resolve({
        runId: message.runId ?? "",
        sessionId: id,
        status: "started",
      })
    );

    const queued = await client.queueBrowserUseSessionMessage(
      sessionId,
      "The code is 4812"
    );

    expect(queued).toMatchObject({ id: 0, sessionId, status: "started" });
    expect(records.recordBrowserVmRun).toHaveBeenCalledExactlyOnceWith({
      id: queued.runId,
      sessionId,
      task: "The code is 4812",
      workspaceId,
    });
    expect(worker.sendBrowserVmWorkerMessage.mock.calls[0]?.[2]).toMatchObject({
      llm: { model: "deepseek/deepseek-v4.1-flash" },
      runId: queued.runId,
      text: "The code is 4812",
    });

    // An idle session starts a run with it: the proxy is seen to first, on
    // the exit the errand's sign-ins were made from.
    expect(lifecycle.prepareBrowserVmSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId }),
      expect.any(Date),
      { rotate: false }
    );

    records.readBrowserVm.mockResolvedValue(vmRow({ state: "stopped" }));
    await expect(
      client.queueBrowserUseSessionMessage(sessionId, "Anything else?")
    ).rejects.toMatchObject({ status: 409 });
  });

  it("leaves the proxy of a live run alone when a message joins it", async () => {
    const client = await loadClient();
    worker.readBrowserVmWorkerSession.mockResolvedValue({
      id: sessionId,
      latestRunId: runId,
      status: "running",
      tabOpen: true,
    });
    worker.sendBrowserVmWorkerMessage.mockResolvedValue({
      runId,
      sessionId,
      status: "queued",
    });

    const queued = await client.queueBrowserUseSessionMessage(
      sessionId,
      "The code is 4812"
    );

    expect(queued).toMatchObject({ runId, status: "queued" });
    expect(lifecycle.prepareBrowserVmSession).not.toHaveBeenCalled();
  });
  it("answers a message the worker took though the bookkeeping after it failed", async () => {
    const client = await loadClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Long enough since the VM was last used that the message touches it.
    records.readBrowserVm.mockResolvedValue(
      vmRow({ lastUsedAt: new Date(Date.now() - 3_600_000) })
    );
    worker.readBrowserVmWorkerSession.mockResolvedValue({
      id: sessionId,
      latestRunId: runId,
      status: "running",
      tabOpen: true,
    });
    worker.sendBrowserVmWorkerMessage.mockResolvedValue({
      runId,
      sessionId,
      status: "queued",
    });
    records.updateBrowserVmRun.mockRejectedValue(
      new Error("connection terminated")
    );
    lifecycle.touchBrowserVm.mockRejectedValue(
      new Error("connection terminated")
    );

    const queued = await client.queueBrowserUseSessionMessage(
      sessionId,
      "The code is 4812"
    );

    expect(queued).toMatchObject({ runId, status: "queued" });
    expect(lifecycle.touchBrowserVm).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("forgetting a VM profile", () => {
  it("wipes the profile on a VM that is up and moves the generation on", async () => {
    const runs = await loadRuns();

    await runs.deleteBrowserVmProfile(profileId);

    expect(worker.resetBrowserVmWorkerProfile).toHaveBeenCalledOnce();
    expect(records.updateBrowserVm).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      { profileGeneration: 2, profileResetPending: false }
    );
  });

  it("leaves the wipe to the VM's next start when it is off", async () => {
    const client = await loadClient();
    records.readBrowserVm.mockResolvedValue(vmRow({ state: "stopped" }));

    await client.deleteBrowserUseProfile(profileId);

    expect(worker.resetBrowserVmWorkerProfile).not.toHaveBeenCalled();
    expect(records.updateBrowserVm).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      { profileGeneration: 2, profileResetPending: true }
    );
  });

  it("does nothing for a profile id that was already forgotten", async () => {
    const runs = await loadRuns();
    records.readBrowserVm.mockResolvedValue(vmRow({ profileGeneration: 2 }));

    await runs.deleteBrowserVmProfile(profileId);

    expect(worker.resetBrowserVmWorkerProfile).not.toHaveBeenCalled();
    expect(records.updateBrowserVm).not.toHaveBeenCalled();
  });
});

describe("looking after the VMs", () => {
  it("needs only the Cloud.ru key and the signing key, not what new errands need", async () => {
    const { BROWSER_VM_SIGNING_KEY, CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET } =
      browserVmTestEnvironment;
    const keysOnly = await importWithSettings(
      { BROWSER_VM_SIGNING_KEY, CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET },
      async () => import("@agent/lib/browser-vm/runs")
    );
    expect(keysOnly.browserVmReconcileConfigured()).toBe(true);

    clearBrowserVmSettings();
    const unsigned = await importWithSettings(
      { CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET },
      async () => import("@agent/lib/browser-vm/runs")
    );
    expect(unsigned.browserVmReconcileConfigured()).toBe(false);
  });
});
