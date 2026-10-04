import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Session } from "eve/channels";
import type { ScheduleHandlerArgs, ScheduleToFn } from "eve/schedules";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { z } from "zod";
import * as Database from "@db";
import * as schema from "@db/schema";
import type { BrowserUseSecretBinding } from "@agent/lib/browser-use/client";
import type * as browserUseClient from "@agent/lib/browser-use/client";
import type * as browserUseSecrets from "@agent/lib/browser-use/secrets";
import type * as browserVmLifecycle from "@agent/lib/browser-vm/lifecycle";
import type * as browserVmRuns from "@agent/lib/browser-vm/runs";
import type * as browserRunsService from "@db/services/browser-runs";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import type { BrowserSubmission } from "@shared/browser/submission";
import type * as browserUseHost from "@agent/lib/browser-use/host";

// The poller runs for real against a real schema: the round-robin take, the
// queue's claim and hand-off, the report lease. Only Browser Use, the
// channels and the owner's Telegram are stand-ins — no live run is started.

interface CloudRun {
  // A VM run that ended with messages it never read: nothing reads them
  // before it settles, and neither the worker nor Bro starts a follow-up
  // for them — the settle path reports them for the coordinator instead.
  unread?: readonly string[];
  result: string | null;
  sessionId: string;
  status: "completed" | "failed" | "running";
  // What the full run summary says, when it lags behind the status endpoint.
  summaryStatus?: "running";
  task: string;
}

const cloud = vi.hoisted(() => ({
  // Whether Browser Use itself is set up: a deployment may run on VMs alone.
  browserUse: true,
  // What happens while Browser Use is starting a run, e.g. a `continue`.
  beforeCreate: new Array<() => Promise<void>>(),
  cancelled: new Array<string>(),
  created: new Array<{
    id?: string;
    search?: boolean;
    secretBindings?: readonly BrowserUseSecretBinding[];
    sessionId?: string;
    task: string;
  }>(),
  // Runs whose status Browser Use keeps failing to answer.
  failing: new Set<string>(),
  // Runs whose summary Browser Use never answers at all.
  hanging: new Set<string>(),
  // How many times a run's status was asked.
  statusChecks: 0,
  // The sessions whose browsers Bro stopped, in order.
  stopped: new Array<string>(),
  // What the next create answers: a new run, or a refusal — Browser Use's
  // own (`busy`, `down`, `no_credits`), a VM session busy with its own run
  // (`vm_busy`, 409), or the workspace's own browser still coming up and
  // asking to be tried again in 15 s (`vm_starting`, 429).
  nextCreate: new Array<
    "busy" | "down" | "no_credits" | "ok" | "vm_busy" | "vm_starting"
  >(),
  runs: new Map<string, CloudRun>(),
}));

const alertOwner = vi.hoisted(() =>
  vi.fn<
    (
      key: string,
      text: string,
      options: { readonly repeatAfterMs: number }
    ) => Promise<boolean>
  >(() => Promise.resolve(true))
);

vi.mock("@agent/lib/owner-alert", () => ({
  alertOwner,
  clearOwnerAlert: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
// Whether a site's name exists is a DNS answer: no test asks the network.
const siteHostMissing = vi.hoisted(() =>
  vi.fn<(site: string) => Promise<boolean>>(() => Promise.resolve(false))
);
vi.mock("@agent/lib/browser-use/host", async (importOriginal) => ({
  ...(await importOriginal<typeof browserUseHost>()),
  siteHostMissing,
}));
vi.mock("@agent/lib/browser-use/images", () => ({
  captureBrowserRunImages: () => Promise.resolve([]),
}));
// The vault can be made to fail, the way a transient outage does.
const vaultFails = vi.hoisted(() => ({ value: false }));
// A vi.fn so a test can see what it was resolved for (the scope and site a
// D1 follow-up must resupply secrets for), and what it hands back.
const resolveBrowserSecretBindings = vi.hoisted(() =>
  vi.fn<typeof browserUseSecrets.resolveBrowserSecretBindings>(() =>
    vaultFails.value
      ? Promise.reject(new Error("vault unavailable"))
      : Promise.resolve({ aliases: [], bindings: [] })
  )
);
vi.mock("@agent/lib/browser-use/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof browserUseSecrets>()),
  resolveBrowserSecretBindings,
}));
vi.mock("@db/services/orders", () => ({
  recordOrder: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
// The real queue service, except that parking can be made to fail. The live
// watch between ticks is off unless a case turns it on: it sleeps, and only
// the case that drives the clock can wait it out.
const parkFails = vi.hoisted(() => ({ value: false }));
const liveWatch = vi.hoisted(() => ({ value: false }));
// The retry queue's claim can be made to fail, the way a dropped connection does.
const retriesFail = vi.hoisted(() => ({ value: false }));
vi.mock("@db/services/browser-runs", async (importOriginal) => {
  const original = await importOriginal<typeof browserRunsService>();
  return {
    ...original,
    claimDueBrowserRunRetries: (
      ...args: Parameters<typeof original.claimDueBrowserRunRetries>
    ) =>
      retriesFail.value
        ? Promise.reject(new Error("connection terminated"))
        : original.claimDueBrowserRunRetries(...args),
    hasLiveBrowserRuns: () =>
      liveWatch.value ? original.hasLiveBrowserRuns() : Promise.resolve(false),
    // An own-browser errand due before the watch ends keeps it going too.
    nextOwnBrowserStarts: (
      ...args: Parameters<typeof original.nextOwnBrowserStarts>
    ) =>
      liveWatch.value
        ? original.nextOwnBrowserStarts(...args)
        : Promise.resolve({ queued: undefined, retry: undefined }),
    parkQueuedBrowserRun: (
      ...args: Parameters<typeof original.parkQueuedBrowserRun>
    ) =>
      parkFails.value
        ? Promise.reject(new Error("connection terminated"))
        : original.parkQueuedBrowserRun(...args),
  };
});
// The browser VMs' lifecycle is its own suite's: here only whether, and
// when in the tick, the poller hands them over. It notes what the tick had
// done by then: the runs the queue started, and the reports sent.
const browserVms = vi.hoisted(() => ({
  configured: false,
  reconciled: new Array<{ readonly sent: number; readonly started: number }>(),
  sent: (): number => 0,
}));
vi.mock("@agent/lib/browser-vm/runs", async (importOriginal) => ({
  ...(await importOriginal<typeof browserVmRuns>()),
  browserVmReconcileConfigured: () => browserVms.configured,
}));
vi.mock("@agent/lib/browser-vm/lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof browserVmLifecycle>()),
  reconcileBrowserVms: () => {
    browserVms.reconciled.push({
      sent: browserVms.sent(),
      started: cloud.created.length,
    });
    return Promise.resolve();
  },
}));
vi.mock("@agent/channels/photon", () => ({ default: { id: "photon" } }));
vi.mock("@agent/channels/telegram", () => ({ default: { id: "telegram" } }));
vi.mock("@agent/lib/browser-use/client", async (importOriginal) => {
  const original = await importOriginal<typeof browserUseClient>();
  function known(runId: string) {
    if (cloud.failing.has(runId)) {
      throw new original.BrowserUseError(503, `/runs/${runId}`, "unavailable");
    }
    const run = cloud.runs.get(runId);
    if (!run) {
      throw new original.BrowserUseError(404, `/runs/${runId}`, "not found");
    }
    return run;
  }
  return {
    ...original,
    browserUseCloudConfigured: () => cloud.browserUse,
    browserUseConfigured: () => true,
    cancelBrowserUseRun: (runId: string) => {
      cloud.cancelled.push(runId);
      return Promise.resolve();
    },
    createBrowserUseRun: async (input: {
      id?: string;
      search?: boolean;
      secretBindings?: readonly BrowserUseSecretBinding[];
      sessionId?: string;
      task: string;
    }) => {
      await cloud.beforeCreate.shift()?.();
      const next = cloud.nextCreate.shift() ?? "ok";
      if (next === "down") {
        return Promise.reject(
          new original.BrowserUseError(500, "/runs", "internal error")
        );
      }
      if (next === "busy") {
        return Promise.reject(
          new original.BrowserUseError(
            429,
            "/runs",
            '{"detail":"Too many concurrent active sessions"}'
          )
        );
      }
      if (next === "vm_starting") {
        return Promise.reject(
          new original.BrowserUseError(
            429,
            "browser-vm",
            "The browser is starting.",
            15_000
          )
        );
      }
      if (next === "vm_busy") {
        return Promise.reject(
          new original.BrowserUseError(
            409,
            "/v1/runs",
            '{"error":"busy","runId":"' + (input.sessionId ?? "") + '"}'
          )
        );
      }
      if (next === "no_credits") {
        return Promise.reject(
          new original.BrowserUseError(402, "/runs", "Insufficient credits")
        );
      }
      cloud.created.push(input);
      const id = input.id ?? `cloud-run-${String(cloud.created.length)}`;
      const sessionId =
        input.sessionId ?? `cloud-session-${String(cloud.created.length)}`;
      cloud.runs.set(id, {
        result: null,
        sessionId,
        status: "running",
        task: input.task,
      });
      return Promise.resolve({
        id,
        model: "hosted-agent",
        sessionId,
        status: "running",
      });
    },
    // Like Browser Use's run list: a live run whose task has the line.
    findRecentBrowserUseRunByTaskLine: (line: string) => {
      const found = [...cloud.runs].find(
        ([id, run]) =>
          !cloud.cancelled.includes(id) && run.task.split("\n").includes(line)
      );
      return Promise.resolve(
        found && {
          id: found[0],
          sessionId: found[1].sessionId,
          status: found[1].status,
          task: found[1].task,
        }
      );
    },
    readBrowserUseRun: (runId: string) => {
      if (cloud.hanging.has(runId)) return new Promise(() => undefined);
      const run = known(runId);
      return Promise.resolve({
        error: null,
        id: runId,
        result: run.result,
        sessionId: run.sessionId,
        status: run.summaryStatus ?? run.status,
        task: run.task,
        unreadMessages: run.unread,
      });
    },
    readBrowserUseRunStatus: (runId: string) => {
      cloud.statusChecks += 1;
      return Promise.resolve(known(runId).status);
    },
    stopBrowserUseSessionBrowsers: (sessionId: string) => {
      cloud.stopped.push(sessionId);
      return Promise.resolve("stopped" as const);
    },
  };
});

const client = new PGlite();
const database = drizzle(client, { schema });
const alice = { userId: "better-auth:alice", workspaceId: "workspace:alice" };

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The poller's real queries run against an isolated PostgreSQL-compatible database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  const { ensureScope } = await import("@db/services/scope");
  await ensureScope(alice);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

beforeEach(async () => {
  await database.delete(schema.spendEntries);
  await database.delete(schema.browserRuns);
  await database.delete(schema.browserSignIns);
  cloud.browserUse = true;
  cloud.beforeCreate.length = 0;
  cloud.cancelled.length = 0;
  cloud.created.length = 0;
  parkFails.value = false;
  liveWatch.value = false;
  retriesFail.value = false;
  cloud.statusChecks = 0;
  cloud.stopped.length = 0;
  vaultFails.value = false;
  cloud.failing.clear();
  cloud.hanging.clear();
  cloud.nextCreate.length = 0;
  cloud.runs.clear();
  browserVms.configured = false;
  browserVms.reconciled.length = 0;
  browserVms.sent = () => 0;
  alertOwner.mockClear();
  resolveBrowserSecretBindings.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function webChat(
  result: Awaited<ReturnType<Session["send"]>> = {
    sessionId: "web-session",
    status: "accepted",
  }
) {
  const send = vi.fn<Session["send"]>(() => Promise.resolve(result));
  const attachSession = vi.fn<ScheduleHandlerArgs["attachSession"]>((id) => ({
    cancel: vi.fn<Session["cancel"]>(),
    clear: vi.fn<Session["clear"]>(),
    compact: vi.fn<Session["compact"]>(),
    getEventStream: vi.fn<Session["getEventStream"]>(),
    getStreamTailIndex: vi.fn<Session["getStreamTailIndex"]>(),
    id,
    reset: vi.fn<Session["reset"]>(),
    respond: vi.fn<Session["respond"]>(),
    send,
  }));
  return { attachSession, send };
}

/** What a report turn put into the chat, as text. */
function sentText(message: Parameters<Session["send"]>[0] | undefined) {
  return z.string().safeParse(message).data ?? JSON.stringify(message);
}

async function tick(attachSession: ScheduleHandlerArgs["attachSession"]) {
  const { default: schedule } = await import("@agent/schedules/browser-runs");
  const tasks: Promise<unknown>[] = [];
  schedule.run({
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession,
    to: vi.fn<ScheduleToFn>(() => {
      throw new Error("These errands all live in the web chat.");
    }),
    waitUntil: (task) => tasks.push(task),
  });
  await Promise.all(tasks);
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** A settled run whose page waits for the person's code. */
const keptPage = {
  conversationChannel: "eve" as const,
  conversationId: "web-session",
  outcome: "Needs: sms_code",
  status: "done" as const,
  task: "Войди на Озон",
};

async function runningErrand(runId: string, result: string) {
  const { createBrowserRun } = await import("@db/services/browser-runs");
  cloud.runs.set(runId, {
    result,
    sessionId: `session-${runId}`,
    status: "completed",
    task: "errand",
  });
  await createBrowserRun(alice, {
    conversationChannel: "eve",
    conversationId: "web-session",
    createdAt: minutesAgo(5),
    id: runId,
    rootSessionId: "web-session",
    sessionId: `session-${runId}`,
    status: "running",
    task: "Найди отель в Казани",
    updatedAt: minutesAgo(5),
  });
}

async function readRun(runId: string) {
  const { readBrowserRun } = await import("@db/services/browser-runs");
  return readBrowserRun(runId);
}

describe("the browser run poller", () => {
  it("delivers every finished run on one poll, even past its batch size", async () => {
    const runIds = Array.from(
      { length: 60 },
      (_, index) => `run-${String(index).padStart(2, "0")}`
    );
    await Promise.all(
      runIds.map((runId) =>
        runningErrand(runId, "RESULT: нашёл отели\nNEEDS: none")
      )
    );
    const { attachSession, send } = webChat();

    await tick(attachSession);

    expect(send).toHaveBeenCalledTimes(60);
    const rows = await Promise.all(runIds.map(readRun));
    // Handed to the chat under a lease; its turn confirms the delivery.
    expect(rows.every((row) => row?.reportClaimedAt instanceof Date)).toBe(
      true
    );
  }, 60_000);

  it("does not let runs that never answer hold back one that finished", async () => {
    const stuck = Array.from(
      { length: 30 },
      (_, index) => `stuck-${String(index)}`
    );
    await Promise.all(
      stuck.map(async (runId) => {
        await runningErrand(runId, "RESULT: —\nNEEDS: none");
        cloud.failing.add(runId);
      })
    );
    // Started after every stuck one, so oldest-first would never reach it.
    const { createBrowserRun } = await import("@db/services/browser-runs");
    cloud.runs.set("finished-run", {
      result: "RESULT: нашёл два отеля\nNEEDS: none",
      sessionId: "session-finished",
      status: "completed",
      task: "errand",
    });
    await createBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(2),
      id: "finished-run",
      sessionId: "session-finished",
      status: "running",
      task: "Найди отель",
      updatedAt: minutesAgo(2),
    });
    const { attachSession, send } = webChat();

    await tick(attachSession);

    expect(send).toHaveBeenCalledOnce();
    expect(sentText(send.mock.calls[0]?.[0])).toContain("finished-run");
  }, 60_000);

  it("delivers a finished run and ends the tick while another run's settle never answers", async () => {
    await import("@agent/schedules/browser-runs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({
      now: new Date(),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
    await runningErrand("stuck-run", "RESULT: нашёл отели\nNEEDS: none");
    cloud.hanging.add("stuck-run");
    await runningErrand("done-run", "RESULT: нашёл два отеля\nNEEDS: none");
    const { attachSession, send } = webChat();

    const finished = { value: false };
    const ticking = tick(attachSession).then(() => {
      finished.value = true;
      return finished.value;
    });
    async function runClock(stepsLeft: number): Promise<void> {
      if (finished.value || stepsLeft === 0) return;
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((resolve) => setImmediate(resolve));
      return runClock(stepsLeft - 1);
    }
    await runClock(120);
    await ticking;

    // The tick waited half a minute on the run that never answered, not
    // forever: the next tick is its own, not this one handed on by Nitro.
    expect(finished.value).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(sentText(send.mock.calls[0]?.[0])).toContain("done-run");
    expect(warn).toHaveBeenCalledWith(
      "[browser-use] run reconciliation is still going",
      { runId: "stuck-run", waitedMs: 30_000 }
    );
    warn.mockRestore();
  }, 60_000);

  it("keeps redelivering and watching overdue reports when an earlier stage fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    retriesFail.value = true;
    const { createBrowserRun } = await import("@db/services/browser-runs");
    // Settled three minutes ago; its first delivery never landed.
    await createBrowserRun(alice, {
      completedAt: minutesAgo(3),
      conversationChannel: "eve",
      conversationId: "web-session",
      id: "owed-run",
      report: "Browser run owed-run finished.",
      sessionId: "session-owed",
      status: "done",
      task: "Найди отель",
    });
    const { attachSession, send } = webChat();

    await tick(attachSession);

    expect(warn).toHaveBeenCalledWith("[browser-use] poll stage failed", {
      cause: new Error("connection terminated"),
      stage: "retry",
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "Browser run owed-run finished.",
      expect.anything()
    );
    // The overdue watch still ran after the failed stage.
    expect(alertOwner).toHaveBeenCalledOnce();
    warn.mockRestore();
  }, 30_000);

  it("settles a run whose summary lags behind its status once the summary has the result", async () => {
    await runningErrand("lagging-run", "RESULT: нашёл отели\nNEEDS: none");
    const lagging = cloud.runs.get("lagging-run");
    if (!lagging) throw new Error("The cloud run is missing.");
    lagging.summaryStatus = "running";
    const { attachSession, send } = webChat();

    await tick(attachSession);

    expect(send).toHaveBeenCalledOnce();
    expect(sentText(send.mock.calls[0]?.[0])).toContain("lagging-run");
    expect((await readRun("lagging-run"))?.status).toBe("done");
  }, 30_000);

  it("closes a run whose summary never catches up once its time is out, and says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createBrowserRun } = await import("@db/services/browser-runs");
    cloud.runs.set("silent-run", {
      result: null,
      sessionId: "session-silent",
      status: "completed",
      summaryStatus: "running",
      task: "errand",
    });
    await createBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(50),
      id: "silent-run",
      sessionId: "session-silent",
      status: "running",
      task: "Найди отель",
      updatedAt: minutesAgo(1),
    });
    const { attachSession, send } = webChat();

    await tick(attachSession);

    // Before, a finished status with a summary that disagreed left the run
    // open for good: never settled, and never expired either.
    expect(warn).toHaveBeenCalledWith(
      "[browser-use] the run ended but its summary has not",
      {
        overdue: true,
        runId: "silent-run",
        status: "completed",
        summaryStatus: "running",
      }
    );
    expect(send).toHaveBeenCalledOnce();
    expect(sentText(send.mock.calls[0]?.[0])).toContain(
      "reports this run as finished but never handed back its result"
    );
    expect((await readRun("silent-run"))?.completedAt).toBeInstanceOf(Date);
    warn.mockRestore();
  }, 30_000);

  it("waits for a lagging summary with no result while the errand still has time", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runningErrand("early-run", "RESULT: —\nNEEDS: none");
    const early = cloud.runs.get("early-run");
    if (!early) throw new Error("The cloud run is missing.");
    early.result = null;
    early.summaryStatus = "running";
    const { attachSession, send } = webChat();

    await tick(attachSession);

    expect(send).not.toHaveBeenCalled();
    expect(cloud.cancelled).toEqual([]);
    expect((await readRun("early-run"))?.completedAt).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[browser-use] the run ended but its summary has not",
      {
        overdue: false,
        runId: "early-run",
        status: "completed",
        summaryStatus: "running",
      }
    );
    warn.mockRestore();
  }, 30_000);

  it("reports a run that finishes between ticks within seconds", async () => {
    await import("@agent/schedules/browser-runs");
    liveWatch.value = true;
    vi.useFakeTimers({ now: new Date(), toFake: ["Date", "setTimeout"] });
    await runningErrand("live-run", "RESULT: нашёл отели\nNEEDS: none");
    const cloudRun = cloud.runs.get("live-run");
    if (!cloudRun) throw new Error("The cloud run is missing.");
    cloudRun.status = "running";
    const { attachSession, send } = webChat();

    const finished = { value: false };
    const ticking = tick(attachSession).then(() => {
      finished.value = true;
      return finished.value;
    });
    // The tick's own pass finds the run still working.
    await vi.waitFor(() => {
      expect(cloud.statusChecks).toBeGreaterThanOrEqual(1);
    });
    expect(send).not.toHaveBeenCalled();
    cloudRun.status = "completed";
    const finishedAt = Date.now();
    // The watch sleeps on the fake clock; the database answers in real time.
    async function runClock(secondsLeft: number): Promise<void> {
      if (finished.value || secondsLeft === 0) return;
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((resolve) => setImmediate(resolve));
      return runClock(secondsLeft - 1);
    }
    await runClock(20);
    await ticking;

    // One look of the live watch, not the next minute's tick; and with
    // nothing left open, the tick ends there.
    expect(send).toHaveBeenCalledOnce();
    expect(sentText(send.mock.calls[0]?.[0])).toContain("live-run");
    expect(Date.now() - finishedAt).toBeLessThanOrEqual(8_000);
  }, 30_000);

  it("backs off a report its chat keeps refusing instead of spending every attempt", async () => {
    // Loaded before the clock is faked: the module runner has timers of its own.
    await import("@agent/schedules/browser-runs");
    liveWatch.value = true;
    vi.useFakeTimers({ now: new Date(), toFake: ["Date", "setTimeout"] });
    await runningErrand("refused-run", "RESULT: нашёл отели\nNEEDS: none");
    // Another errand still running keeps the watch going all tick long.
    await runningErrand("busy-run", "RESULT: —\nNEEDS: none");
    const busy = cloud.runs.get("busy-run");
    if (!busy) throw new Error("The cloud run is missing.");
    busy.status = "running";
    // The chat is down for the whole tick.
    const { attachSession, send } = webChat({
      retryable: true,
      status: "session_not_active",
    });

    const finished = { value: false };
    const ticking = tick(attachSession).then(() => {
      finished.value = true;
      return finished.value;
    });
    // The watch sleeps on the fake clock while the database answers in real
    // time, so the clock moves in small steps until the tick is over.
    async function runClock(stepsLeft: number): Promise<void> {
      if (finished.value || stepsLeft === 0) return;
      await vi.advanceTimersByTimeAsync(250);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return runClock(stepsLeft - 1);
    }
    await runClock(2_000);
    await ticking;

    // Looked at every few seconds, sent twice: at once and after 30 s.
    expect(cloud.statusChecks).toBeGreaterThan(5);
    expect(send).toHaveBeenCalledTimes(2);
    const row = await readRun("refused-run");
    expect(row?.reportAttempts).toBe(2);
    expect(row?.reportDeliveredAt).toBeNull();
  }, 60_000);

  it("asks the person for the SMS code on the very next poll", async () => {
    await runningErrand(
      "gosuslugi-run",
      [
        "Дошёл до входа на Госуслуги, сайт прислал код.",
        "RESULT: остановился на вводе кода из СМС",
        "NEEDS: sms_code",
        "DETAILS: код отправлен на +7 *** ***-12-34",
      ].join("\n")
    );
    const { attachSession, send } = webChat();

    await tick(attachSession);

    expect(send).toHaveBeenCalledOnce();
    const report = sentText(send.mock.calls[0]?.[0]);
    // The web chat hides Bro's own prompt instead of showing it as the
    // person's message.
    expect(report.startsWith(backgroundTurnMarker)).toBe(true);
    expect(report).toContain("+7 *** ***-12-34");
    expect(report).toContain(
      "The site is waiting for a one-time code it sent by SMS: open your one message with a short line asking the user for that code"
    );
    // The request opens the one message, and the result goes in it too: a
    // second message would be dropped as a repeat of the report.
    expect(report).toContain(
      "what the run did and found so far follows in that same message"
    );
    // RU 25.09: the report turn filled the masked phone in and then made the
    // code up itself. The phone is quoted as masked, and the turn ends there.
    expect(report).toContain(
      "naming the phone it went to exactly as Details masks it — «***-**-76» stays «***-**-76», never with digits filled in"
    );
    expect(report).toContain(
      "Then end this turn: only the user's own reply with the code continues the run"
    );
    expect((await readRun("gosuslugi-run"))?.reportClaimedAt).toBeInstanceOf(
      Date
    );
    // The code goes into that very page: its browser stays up.
    expect(cloud.stopped).toEqual([]);
    expect((await readRun("gosuslugi-run"))?.browserReleasedAt).toBeNull();
  }, 30_000);

  it("keeps a staged checkout open for the card's follow-up", async () => {
    await runningErrand(
      "staged-run",
      [
        "RESULT: корзина собрана, остановлено перед оплатой",
        "TOTAL: 1 422 ₽",
        "NEEDS: payment",
      ].join("\n")
    );
    const { attachSession } = webChat();

    await tick(attachSession);

    // The card's follow-up goes on on that very checkout page; the idle stop
    // closes it cleanly if nobody answers.
    expect(cloud.stopped).toEqual([]);
    expect((await readRun("staged-run"))?.browserReleasedAt).toBeNull();
  }, 30_000);

  it("stops the browser of a run with nothing left for the person, so its sign-ins are kept", async () => {
    await runningErrand(
      "done-run",
      ["RESULT: такси заказано", "NEEDS: none"].join("\n")
    );
    const { attachSession } = webChat();

    await tick(attachSession);

    expect(cloud.stopped).toEqual(["session-done-run"]);
    const row = await readRun("done-run");
    expect(row?.browserReleasedAt).toBeInstanceOf(Date);
    expect(row?.liveViewUrl).toBeNull();
  }, 30_000);

  it("stops a browser kept for the person once it sat idle, and only once", async () => {
    // The cloud ends an idle browser about twenty minutes after its last
    // run and loses what changed in it: a push the person approved without
    // saying so, a sign-in finished in the live view.
    const { createBrowserRun } = await import("@db/services/browser-runs");
    await createBrowserRun(alice, {
      ...keptPage,
      completedAt: minutesAgo(16),
      createdAt: minutesAgo(20),
      id: "idle-run",
      liveViewUrl: "https://live.browser-use.test/idle",
      sessionId: "session-idle",
      updatedAt: minutesAgo(16),
    });
    const { attachSession } = webChat();

    await tick(attachSession);
    await tick(attachSession);

    expect(cloud.stopped).toEqual(["session-idle"]);
    const idle = await readRun("idle-run");
    expect(idle?.browserReleasedAt).toBeInstanceOf(Date);
    expect(idle?.liveViewUrl).toBeNull();
  }, 30_000);

  it("lets another browser of the workspace stop first, for a few minutes", async () => {
    // Whether the cloud merges two browsers' cookies on one profile or keeps
    // the last one's is not known: the page that waited longest stops last.
    const { createBrowserRun } = await import("@db/services/browser-runs");
    await createBrowserRun(alice, {
      ...keptPage,
      completedAt: minutesAgo(16),
      createdAt: minutesAgo(20),
      id: "idle-run",
      sessionId: "session-idle",
      updatedAt: minutesAgo(16),
    });
    await createBrowserRun(alice, {
      ...keptPage,
      completedAt: minutesAgo(3),
      createdAt: minutesAgo(6),
      id: "waiting-run",
      sessionId: "session-waiting",
      updatedAt: minutesAgo(3),
    });
    const { attachSession } = webChat();

    await tick(attachSession);

    expect(cloud.stopped).toEqual([]);
    // Given back, not left claimed: a follow-up may still take it.
    expect((await readRun("idle-run"))?.browserReleasedAt).toBeNull();

    // Short of the cloud's own cleanup it stops whatever else is up.
    await database
      .update(schema.browserRuns)
      .set({ completedAt: minutesAgo(19) })
      .where(eq(schema.browserRuns.id, "idle-run"));

    await tick(attachSession);

    expect(cloud.stopped).toEqual(["session-idle"]);
    expect((await readRun("waiting-run"))?.browserReleasedAt).toBeNull();
  }, 30_000);

  it("answers a payment stop with one question in text, not a card", async () => {
    await runningErrand(
      "payment-run",
      [
        "Корзина собрана, дошёл до оплаты.",
        "RESULT: остановился перед оплатой",
        "TOTAL: 2 400 ₽",
        "NEEDS: payment",
        'ITEMS: [{"name":"Кофе Jardin 1 кг","price":"2 400 ₽","quantity":"1"}]',
      ].join("\n")
    );
    const { attachSession, send } = webChat();

    await tick(attachSession);

    const report = sentText(send.mock.calls[0]?.[0]);
    expect(report).toContain(
      "the total with every fee from Total, the delivery or the date — ending with «Оплачиваю?»"
    );
    expect(report).toContain(
      "only their plain yes in the next message continues this run with allowSubmit and a submission naming exactly the option it staged with the real chargeRub"
    );
  }, 30_000);

  it("reports a basket and hotels as a list of what the run found", async () => {
    await runningErrand(
      "basket-run",
      [
        "Собрал корзину на Ozon.",
        "RESULT: корзина собрана",
        "TOTAL: 1 337,10 ₽",
        "NEEDS: payment",
        'ITEMS: [{"name":"Молоко Простоквашино 2,5%","price":"89,90 ₽","quantity":2,"url":"https://www.ozon.ru/product/moloko-1"},{"name":"Хлеб Бородинский","price":"57,30 ₽","quantity":1,"url":null},{"name":"Кофе Jardin 250 г","price":"1 100 ₽","quantity":1,"details":"доставка завтра","url":"https://www.ozon.ru/product/kofe-3"}]',
      ].join("\n")
    );
    await runningErrand(
      "hotels-run",
      [
        "RESULT: найдено 2 отеля",
        "NEEDS: none",
        'ITEMS: [{"name":"Отель Кремлёвский","price":"6 500 ₽ за ночь","details":"12–14 октября, бесплатная отмена до 10 октября","url":"https://ostrovok.ru/hotel/kremlin"},{"name":"Гранд Отель Казань","price":"7 200 ₽ за ночь","details":"12–14 октября, без отмены","url":"https://ostrovok.ru/hotel/grand"}]',
      ].join("\n")
    );
    const { attachSession, send } = webChat();

    await tick(attachSession);

    const reports = send.mock.calls.map(([message]) => sentText(message));
    const basket = reports.find((report) => report.includes("basket-run"));
    const hotels = reports.find((report) => report.includes("hotels-run"));
    expect(basket).toContain(
      "1. Молоко Простоквашино 2,5% — 89,90 ₽ — qty 2 — https://www.ozon.ru/product/moloko-1"
    );
    expect(basket).toContain("2. Хлеб Бородинский — 57,30 ₽ — qty 1");
    expect(basket).toContain(
      "3. Кофе Jardin 250 г — 1 100 ₽ — qty 1 — доставка завтра"
    );
    expect(hotels).toContain(
      "1. Отель Кремлёвский — 6 500 ₽ за ночь — 12–14 октября, бесплатная отмена до 10 октября — https://ostrovok.ru/hotel/kremlin"
    );
    expect(hotels).toContain("2. Гранд Отель Казань");
    for (const report of [basket, hotels]) {
      expect(report).toContain("give the user every item as a list");
    }
  }, 30_000);

  it("closes a run Browser Use no longer knows instead of polling it forever", async () => {
    const { createBrowserRun } = await import("@db/services/browser-runs");
    await createBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(5),
      id: "vanished-run",
      sessionId: "vanished-session",
      status: "running",
      task: "Найди отель",
      updatedAt: minutesAgo(5),
    });
    const { attachSession, send } = webChat();

    await tick(attachSession);

    const row = await readRun("vanished-run");
    expect(row?.status).toBe("failed");
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(sentText(send.mock.calls[0]?.[0])).toContain(
      "no longer has this run"
    );
  }, 30_000);

  it("tells the owner when finished errands have not reached their people", async () => {
    await runningErrand("stuck-run", "RESULT: готово\nNEEDS: none");
    const unreachable = webChat({
      retryable: false,
      status: "session_not_active",
    });
    await tick(unreachable.attachSession);
    expect(alertOwner).not.toHaveBeenCalled();

    vi.useFakeTimers({ now: Date.now() + 3 * 60_000, toFake: ["Date"] });
    await tick(unreachable.attachSession);

    expect(alertOwner).toHaveBeenCalledWith(
      "browser-use-undelivered-reports",
      expect.stringContaining("1 шт."),
      expect.anything()
    );
  }, 30_000);
});

const cardSubmission: BrowserSubmission = {
  forWhom: "Алиса",
  personalData: ["имя", "телефон"],
  kind: "table",
  what: "бронь столика на двоих",
  when: "пятница, 19:00",
  where: "ресторан «Пушкин»",
};

describe("a VM run that ended with messages it never read", () => {
  const runId = `vm:${alice.workspaceId}:r:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d`;
  const sessionId = `vm:${alice.workspaceId}:s:5e7d2c1a-8b9f-4e3d-a2c1-0f9e8d7c6b5a`;

  async function trackVmErrand() {
    const { createBrowserRun } = await import("@db/services/browser-runs");
    await createBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(5),
      id: runId,
      profileId: `vm:${alice.workspaceId}:p1`,
      rootSessionId: "web-session",
      sessionId,
      status: "running",
      task: "Найди отель в Казани",
      updatedAt: minutesAgo(5),
    });
  }

  // The message came during the run's last step: nothing read it before it
  // settled. The worker never starts a follow-up on its own (D1), and
  // neither does Bro any more: no run of its own, only a line in the report.
  it("tells the coordinator about the message in the report, and starts nothing itself", async () => {
    cloud.runs.set(runId, {
      result: "RESULT: нашёл отель «Казанская»\nNEEDS: none",
      sessionId,
      status: "completed",
      task: "errand",
      unread: ["и с завтраком"],
    });
    await trackVmErrand();
    const { attachSession, send } = webChat();

    await tick(attachSession);

    // No follow-up run, on this session or any other.
    expect(cloud.created).toHaveLength(0);
    expect(send).toHaveBeenCalledOnce();
    const report = sentText(send.mock.calls[0]?.[0]);
    expect(report).toContain("«и с завтраком»");
    expect(report).toContain("browser_task continue");
    // Never folded into the untrusted-browser-data disclaimer above it, and
    // never claimed as the page's own text.
    expect(report).toContain("never something the page displayed");
    const ended = await readRun(runId);
    expect(ended?.completedAt).toBeInstanceOf(Date);
    expect(ended?.retriedAsRunId).toBeNull();
  }, 30_000);

  it("says nothing about unread messages for a run that ended with none", async () => {
    cloud.runs.set(runId, {
      result: "RESULT: нашёл отель «Казанская»\nNEEDS: none",
      sessionId,
      status: "completed",
      task: "errand",
    });
    await trackVmErrand();
    const { attachSession, send } = webChat();

    await tick(attachSession);

    expect(cloud.created).toHaveLength(0);
    expect(send).toHaveBeenCalledOnce();
    const report = sentText(send.mock.calls[0]?.[0]);
    expect(report).not.toContain(
      "reached the browser only as this run was ending"
    );
  }, 30_000);
});

async function queuedErrand(
  index: number,
  submission?: BrowserSubmission,
  profileId = "profile-1",
  startedByPerson = true
) {
  const { createQueuedBrowserRun } = await import("@db/services/browser-runs");
  return createQueuedBrowserRun(alice, {
    conversationChannel: "eve",
    conversationId: "web-session",
    createdAt: minutesAgo(10 - index),
    paymentAllowed: false,
    pendingTask: `Полный текст поручения ${String(index)}`,
    profileId,
    retryAt: minutesAgo(1),
    rootSessionId: "web-session",
    site: "https://example.ru",
    startedByPerson,
    submission: submission ?? null,
    task: `Поручение ${String(index)}`,
  });
}

/**
 * The queue as a deployment with this FLASH_SEARCH_WORKSPACES loads it. The
 * settings are read once per module graph, so the graph is loaded afresh,
 * on the same database.
 */
async function queueWithFlashPilot(list: string) {
  vi.stubEnv("FLASH_SEARCH_WORKSPACES", list);
  vi.resetModules();
  const fresh = await import("@db");
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fresh module graph's queries run against the same isolated database.
  vi.spyOn(fresh, "db", "get").mockReturnValue(database as never);
  return import("@agent/lib/browser-use/queue");
}

describe("the browser queue", () => {
  it("tries only the first errand while Browser Use is at its cap", async () => {
    const first = await queuedErrand(0);
    await queuedErrand(1);
    await queuedErrand(2);
    cloud.nextCreate.push("busy");
    const { attachSession, send } = webChat();

    await tick(attachSession);

    // One refused start, not a storm: the others would get the same 429.
    expect(cloud.created).toHaveLength(0);
    expect(cloud.nextCreate).toHaveLength(0);
    const row = await readRun(first.id);
    expect(row?.status).toBe("queued");
    expect(row?.retryAt?.getTime()).toBeGreaterThan(Date.now());
    expect(send).not.toHaveBeenCalled();
  }, 30_000);

  it("goes on past an errand whose workspace's VM is starting or busy", async () => {
    // A VM belongs to one workspace: its 429 says nothing about Browser
    // Use's cap, nor about any other workspace's VM.
    const onVm = await queuedErrand(0, undefined, `vm:${alice.workspaceId}:p1`);
    await queuedErrand(1);
    cloud.nextCreate.push("busy");
    const { attachSession } = webChat();

    await tick(attachSession);

    expect(cloud.created).toHaveLength(1);
    expect(cloud.created[0]?.task).toContain("Полный текст поручения 1");
    const parked = await readRun(onVm.id);
    expect(parked?.status).toBe("queued");
    expect(parked?.retryAt?.getTime()).toBeGreaterThan(Date.now());
  }, 30_000);

  it.each([
    [true, null],
    [false, "set"],
  ] as const)(
    "puts the VM on the window of whoever asked, when a queued errand starts on it (the person: %s)",
    async (startedByPerson, window) => {
      const vms = await import("@db/services/browser-vms");
      await vms.ensureBrowserVmRecord(alice.workspaceId);
      // An errand nobody waited for had put the VM on its short window.
      await vms.updateBrowserVm(alice.workspaceId, {
        stopNotBefore: startedByPerson ? new Date() : null,
      });
      await queuedErrand(
        0,
        undefined,
        `vm:${alice.workspaceId}:p1`,
        startedByPerson
      );
      const { attachSession } = webChat();

      await tick(attachSession);

      expect(cloud.created).toHaveLength(1);
      const vm = await vms.readBrowserVm(alice.workspaceId);
      expect(vm?.stopNotBefore === null ? null : "set").toBe(window);
    },
    30_000
  );

  it("goes on with errands on a VM once Browser Use is at its cap, and with no one else's", async () => {
    const first = await queuedErrand(0);
    await queuedErrand(1, undefined, `vm:${alice.workspaceId}:p1`);
    const last = await queuedErrand(2);
    cloud.nextCreate.push("busy");
    const { attachSession } = webChat();

    await tick(attachSession);

    // The VM's errand does not wait on Browser Use's cap; Browser Use's next
    // errand would only get the same 429, so it is not tried.
    expect(cloud.created).toHaveLength(1);
    expect(cloud.created[0]?.task).toContain("Полный текст поручения 1");
    expect((await readRun(first.id))?.retryAt?.getTime()).toBeGreaterThan(
      Date.now()
    );
    expect((await readRun(last.id))?.retryAt?.getTime()).toBeLessThan(
      Date.now()
    );
  }, 30_000);

  it("looks after the browser VMs after the reports, and only where Cloud.ru is set up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { attachSession, send } = webChat();
    browserVms.sent = () => send.mock.calls.length;

    await tick(attachSession);

    expect(browserVms.reconciled).toEqual([]);

    browserVms.configured = true;
    await queuedErrand(0);
    const { createBrowserRun } = await import("@db/services/browser-runs");
    // Settled three minutes ago; its first delivery never landed.
    await createBrowserRun(alice, {
      completedAt: minutesAgo(3),
      conversationChannel: "eve",
      conversationId: "web-session",
      id: "owed-run",
      report: "Browser run owed-run finished.",
      sessionId: "session-owed",
      status: "done",
      task: "Найди отель",
    });

    await tick(attachSession);

    // A Cloud.ru outage must not hold the queue or a report back: the VMs
    // are looked after once both are done, and an errand whose VM came up
    // starts on the next tick.
    expect(browserVms.reconciled).toEqual([{ sent: 1, started: 1 }]);
    warn.mockRestore();
  }, 30_000);

  it("starts the errand once a browser frees up and carries the person's approval", async () => {
    const queued = await queuedErrand(0, cardSubmission);
    const { attachSession } = webChat();

    await tick(attachSession);

    expect(cloud.created).toHaveLength(1);
    expect(cloud.created[0]?.task).toContain("Полный текст поручения 0");
    expect(cloud.created[0]?.task).toContain(`Queued errand ${queued.id}`);
    const handedOver = await readRun(queued.id);
    expect(handedOver?.status).toBe("stopped");
    expect(handedOver?.pendingTask).toBeNull();
    expect(handedOver?.retriedAsRunId).toBe("cloud-run-1");
    const started = await readRun("cloud-run-1");
    expect(started).toMatchObject({
      sessionId: "cloud-session-1",
      status: "running",
      submission: cardSubmission,
      task: "Поручение 0",
    });
    const { readLatestBrowserRunForScope } =
      await import("@db/services/browser-runs");
    expect((await readLatestBrowserRunForScope(alice, queued.id))?.id).toBe(
      "cloud-run-1"
    );
  }, 30_000);

  it("restarts an errand the person changed while its run was starting", async () => {
    const queued = await queuedErrand(0, cardSubmission);
    const { updateQueuedBrowserRun } =
      await import("@db/services/browser-runs");
    // The person's `continue` lands after the poller read the errand and
    // while Browser Use is starting the run from that reading.
    let continued: boolean | undefined;
    cloud.beforeCreate.push(async () => {
      continued = await updateQueuedBrowserRun(queued.id, {
        pendingTask: "Полный текст поручения 0\n\nUpdate: столик у окна",
      });
    });
    const { attachSession } = webChat();

    await tick(attachSession);

    // The tool told the person the update is part of the errand: it is.
    expect(continued).toBe(true);
    expect(cloud.created).toHaveLength(2);
    expect(cloud.created[0]?.task).not.toContain("столик у окна");
    expect(cloud.cancelled).toEqual(["cloud-run-1"]);
    expect(cloud.created[1]?.task).toContain("столик у окна");
    expect(cloud.created[1]?.task).toContain(
      `(Queued errand ${queued.id}, change 1; for bookkeeping only.)`
    );
    expect(await readRun(queued.id)).toMatchObject({
      retriedAsRunId: "cloud-run-2",
      status: "stopped",
    });
    expect(await readRun("cloud-run-1")).toBeUndefined();
    expect(await readRun("cloud-run-2")).toMatchObject({
      status: "running",
      submission: cardSubmission,
    });
  }, 30_000);

  it("adopts the run a dead poller started before asking the vault or the clock", async () => {
    const queued = await queuedErrand(0);
    const expired = await queuedErrand(1);
    // This one has waited past the queue window.
    await database
      .update(schema.browserRuns)
      .set({ createdAt: minutesAgo(120) })
      .where(eq(schema.browserRuns.id, expired.id));
    // A poller started both runs and died before handing the errands over.
    for (const [index, row] of [queued, expired].entries()) {
      cloud.runs.set(`orphan-run-${String(index)}`, {
        result: null,
        sessionId: `orphan-session-${String(index)}`,
        status: "running",
        task: `Полный текст поручения ${String(index)}\n\n(Queued errand ${row.id}; for bookkeeping only.)`,
      });
    }
    vaultFails.value = true;
    const { attachSession, send } = webChat();

    await tick(attachSession);

    // Neither run is left working untracked, and neither errand is told it
    // never started.
    expect(cloud.created).toHaveLength(0);
    expect(cloud.cancelled).toHaveLength(0);
    expect(await readRun(queued.id)).toMatchObject({
      retriedAsRunId: "orphan-run-0",
      status: "stopped",
    });
    expect(await readRun(expired.id)).toMatchObject({
      retriedAsRunId: "orphan-run-1",
      status: "stopped",
    });
    expect(await readRun("orphan-run-1")).toMatchObject({
      sessionId: "orphan-session-1",
      status: "running",
    });
    expect(send).not.toHaveBeenCalled();
  }, 30_000);

  it("starts a queued errand that only searches in flash mode, in the pilot alone and never wider", async () => {
    onTestFinished(async () => {
      await queueWithFlashPilot("");
    });
    const { stagingLead } = await import("@agent/lib/browser-use/staging");
    const { createBrowserRun, createQueuedBrowserRun } =
      await import("@db/services/browser-runs");
    // On no site, so that none waits for another's sign-in.
    const queue = (
      index: number,
      row: Partial<Parameters<typeof createQueuedBrowserRun>[1]> = {},
      fromRunId?: string
    ) =>
      createQueuedBrowserRun(
        alice,
        {
          conversationChannel: "eve",
          conversationId: "web-session",
          createdAt: minutesAgo(10 - index),
          paymentAllowed: false,
          pendingTask: `Полный текст поручения ${String(index)}`,
          profileId: "profile-1",
          retryAt: minutesAgo(1),
          rootSessionId: "web-session",
          site: null,
          startedByPerson: true,
          submission: null,
          task: `Поручение ${String(index)}`,
          ...row,
        },
        fromRunId
      );
    const search = await queue(0);
    const confirmed = await queue(1, { submission: cardSubmission });
    const paying = await queue(2, { paymentAllowed: true });
    const staged = await queue(3, {
      pendingTask: `Забронируй столик\n\n${stagingLead}`,
    });
    const signedIn = await queue(4);
    // A follow-up waiting for a browser: it keeps full mode.
    await createBrowserRun(alice, {
      completedAt: minutesAgo(2),
      conversationChannel: "eve",
      conversationId: "web-session",
      id: "searched-run",
      rootSessionId: "web-session",
      sessionId: "session-searched-run",
      status: "done",
      task: "Найди отель в Казани",
    });
    const followUp = await queue(
      5,
      { task: "Человек написал: «а подешевле?»" },
      "searched-run"
    );
    const unflagged = await queue(6);

    const pilot = await queueWithFlashPilot(alice.workspaceId);
    const start = async (
      startQueued: typeof pilot.startQueuedBrowserRun,
      id: string
    ) => {
      const row = await readRun(id);
      if (!row) throw new Error("The queued errand is gone.");
      return startQueued(row);
    };
    const started = [];
    for (const row of [search, confirmed, paying, staged]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The errands start one by one, as the poller starts them.
      started.push(await start(pilot.startQueuedBrowserRun, row.id));
    }
    resolveBrowserSecretBindings.mockResolvedValueOnce({
      aliases: ["login_username"],
      bindings: [
        {
          alias: "login_username",
          allowedDomains: ["example.ru"],
          source: { type: "inline", value: "alice@example.com" },
        },
      ],
    });
    started.push(await start(pilot.startQueuedBrowserRun, signedIn.id));
    started.push(await start(pilot.startQueuedBrowserRun, followUp.id));
    // Unset, every queued errand starts as it always did.
    const unset = await queueWithFlashPilot("");
    started.push(await start(unset.startQueuedBrowserRun, unflagged.id));

    expect(started.map((result) => result.status)).toEqual(
      Array.from({ length: 7 }, () => "started")
    );
    expect(cloud.created.map((input) => input.search)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  }, 30_000);

  it("finishes the tick when a failed start cannot even be parked", async () => {
    const { createBrowserRun } = await import("@db/services/browser-runs");
    // A report whose earlier delivery failed waits for this tick's retry.
    await createBrowserRun(alice, {
      completedAt: minutesAgo(1),
      conversationChannel: "eve",
      conversationId: "web-session",
      id: "undelivered-run",
      outcome: "нашёл отели",
      report: "RESULT: нашёл отели",
      rootSessionId: "web-session",
      sessionId: "session-undelivered-run",
      status: "done",
      task: "Найди отель в Казани",
    });
    const queued = await queuedErrand(0);
    cloud.nextCreate.push("down");
    parkFails.value = true;
    const { attachSession, send } = webChat();

    await tick(attachSession);

    // Redelivery comes after the queue in the tick, and still ran.
    expect(send).toHaveBeenCalledOnce();
    expect((await readRun("undelivered-run"))?.reportClaimedAt).toBeInstanceOf(
      Date
    );
    // The claim's lease puts the errand back in line later.
    expect((await readRun(queued.id))?.status).toBe("queued");
  }, 30_000);

  it("starts an errand on an account only once the workspace's other browser there is done", async () => {
    // RU 25.09: d06, d07 and d08 signed in to Госуслуги at once, the person
    // got three codes, and every sign-in was thrown out.
    const { countQueuedBrowserRuns, createBrowserRun, createQueuedBrowserRun } =
      await import("@db/services/browser-runs");
    cloud.runs.set("esia-run", {
      result: null,
      sessionId: "session-esia",
      status: "running",
      task: "errand",
    });
    await createBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(3),
      id: "esia-run",
      rootSessionId: "web-session",
      sessionId: "session-esia",
      site: "https://www.gosuslugi.ru",
      status: "running",
      task: "Проверь штрафы на Госуслугах",
      updatedAt: minutesAgo(3),
    });
    const waiting = await createQueuedBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(2),
      paymentAllowed: false,
      pendingTask: "Запиши к терапевту через ЕМИАС",
      profileId: "profile-1",
      retryAt: minutesAgo(1),
      rootSessionId: "web-session",
      site: "https://emias.info",
      task: "Запиши к терапевту",
    });
    const { attachSession } = webChat();

    await tick(attachSession);

    expect(cloud.created).toHaveLength(0);
    const parked = await readRun(waiting.id);
    expect(parked?.status).toBe("queued");
    expect(parked?.waitsForAccount).toBe("gosuslugi.ru");
    expect(parked?.retryAt?.getTime()).toBeGreaterThan(Date.now());
    // It waits for its own workspace, not for Browser Use: nobody else's
    // start queues up behind it.
    expect(await countQueuedBrowserRuns()).toBe(0);

    // The Госуслуги errand signs in and is done: its browser is stopped,
    // which is what keeps the sign-in, and the waiting errand starts on it.
    cloud.runs.set("esia-run", {
      result: [
        "RESULT: штрафов нет",
        "NEEDS: none",
        "SIGNED_IN: https://lk.gosuslugi.ru/profile?from=main",
      ].join("\n"),
      sessionId: "session-esia",
      status: "completed",
      task: "errand",
    });
    await database
      .update(schema.browserRuns)
      .set({ retryAt: minutesAgo(1) })
      .where(eq(schema.browserRuns.id, waiting.id));

    await tick(attachSession);

    expect(cloud.stopped).toEqual(["session-esia"]);
    expect(cloud.created).toHaveLength(1);
    expect(cloud.created[0]?.task).toContain("Запиши к терапевту через ЕМИАС");
    const started = await readRun(waiting.id);
    expect(started?.retriedAsRunId).toBe("cloud-run-1");
    expect(started?.waitsForAccount).toBeNull();
    const { readBrowserSignIns } =
      await import("@db/services/browser-sign-ins");
    expect(
      await readBrowserSignIns(alice.workspaceId, ["gosuslugi.ru"])
    ).toEqual([
      expect.objectContaining({
        accountUrl: "https://lk.gosuslugi.ru/profile",
        state: "signed_in",
      }),
    ]);
  }, 30_000);

  it("never holds back a queued follow-up of the errand that holds the account", async () => {
    const { createBrowserRun, createQueuedBrowserRun } =
      await import("@db/services/browser-runs");
    cloud.runs.set("esia-run", {
      result: null,
      sessionId: "session-esia",
      status: "running",
      task: "errand",
    });
    await createBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(3),
      id: "esia-run",
      sessionId: "session-esia",
      site: "https://www.gosuslugi.ru",
      status: "running",
      task: "Проверь штрафы",
      updatedAt: minutesAgo(3),
    });
    // A follow-up queued for a browser carries its errand's session.
    const followUp = await createQueuedBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(2),
      paymentAllowed: false,
      pendingTask: "Код из смс 739204",
      profileId: "profile-1",
      retryAt: minutesAgo(1),
      rootSessionId: "web-session",
      sessionId: "session-other",
      site: "https://www.gosuslugi.ru",
      task: "Код из смс 739204",
    });
    const { attachSession } = webChat();

    await tick(attachSession);

    expect(cloud.created).toHaveLength(1);
    expect((await readRun(followUp.id))?.retriedAsRunId).toBe("cloud-run-1");
  }, 30_000);

  it("waits behind a page staged on the same account and never closes it", async () => {
    // Verification of wave 6 (d07/d08): d07's slot waits on its card; d08,
    // queued for Госуслуги, must not close that page to start.
    const { createBrowserRun, createQueuedBrowserRun } =
      await import("@db/services/browser-runs");
    await createBrowserRun(alice, {
      ...keptPage,
      completedAt: minutesAgo(1),
      createdAt: minutesAgo(8),
      id: "staged-slot",
      outcome: "Needs: decision",
      sessionId: "session-staged",
      site: "https://www.gosuslugi.ru",
      updatedAt: minutesAgo(1),
    });
    const waiting = await createQueuedBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(2),
      paymentAllowed: false,
      pendingTask: "Запиши к терапевту через ЕМИАС",
      profileId: "profile-1",
      retryAt: minutesAgo(1),
      rootSessionId: "web-session",
      site: "https://emias.info",
      task: "Запиши к терапевту",
      waitsForAccount: "gosuslugi.ru",
    });
    // A follow-up that lost its page signs in anew: it waits as well, its
    // session notwithstanding.
    const reopened = await createQueuedBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(2),
      paymentAllowed: false,
      pendingTask: "Продолжи запись на mos.ru",
      profileId: "profile-1",
      retryAt: minutesAgo(1),
      rootSessionId: "web-session",
      sessionId: "session-mos",
      site: "https://www.mos.ru",
      task: "Продолжи",
      waitsForAccount: "gosuslugi.ru",
    });
    const { attachSession } = webChat();

    await tick(attachSession);

    expect(cloud.stopped).toEqual([]);
    expect(cloud.created).toHaveLength(0);
    expect((await readRun("staged-slot"))?.browserReleasedAt).toBeNull();
    for (const queued of [waiting, reopened]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two rows, read in turn.
      const row = await readRun(queued.id);
      expect(row?.status).toBe("queued");
      expect(row?.waitsForAccount).toBe("gosuslugi.ru");
    }
  }, 30_000);

  it("tells Bro a Госуслуги errand in the wait may still ask for a code", async () => {
    const { queuedStatusNote } = await import("@agent/lib/browser-use/queue");

    const note = await queuedStatusNote({
      profileId: "profile-1",
      waitsForAccount: "gosuslugi.ru",
    });

    expect(note).not.toContain("starts signed in");
    expect(note).not.toContain("instead of sending a second code");
    expect(note).toContain("Госуслуги asks for one in every new browser");
    expect(note).toContain("do not promise there will be none");
  });

  it("tells Bro an errand waiting for the person's own VM that their browser is starting", async () => {
    const { queuedStatusNote } = await import("@agent/lib/browser-use/queue");
    const waiting = { waitsForAccount: null };

    const onVm = await queuedStatusNote({
      ...waiting,
      profileId: `vm:${alice.workspaceId}:p1`,
    });
    const onBrowserUse = await queuedStatusNote({
      ...waiting,
      profileId: "profile-1",
    });

    // No VM yet: its very first start, said in minutes, never as a time.
    expect(onVm).toContain(
      "Bro's own browser for the user is being set up for its very first start, which takes about 6 more minutes"
    );
    expect(onVm).toContain("in minutes rather than a time of day");
    expect(onVm).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    expect(onVm).not.toContain("cloud browser service");
    expect(onBrowserUse).toContain(
      "the cloud browser service had no free browser for it yet"
    );
    expect(onBrowserUse).not.toContain("next try");
  });

  it("closes a queued errand, tells the person and alerts the owner when credits run out", async () => {
    const queued = await queuedErrand(0);
    await queuedErrand(1);
    cloud.nextCreate.push("no_credits");
    const { attachSession, send } = webChat();

    await tick(attachSession);

    expect((await readRun(queued.id))?.status).toBe("failed");
    expect(send).toHaveBeenCalledOnce();
    expect(sentText(send.mock.calls[0]?.[0])).toContain(
      "the cloud browser service became unavailable"
    );
    expect(alertOwner).toHaveBeenCalledWith(
      "browser-use-no-credits",
      expect.stringContaining("402"),
      expect.anything()
    );
  }, 30_000);

  it("closes Browser Use errands on a deployment without it, without holding back the VMs'", async () => {
    cloud.browserUse = false;
    const waiting = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) => queuedErrand(index))
    );
    const onVm = await queuedErrand(6, undefined, `vm:${alice.workspaceId}:p1`);
    const { attachSession, send } = webChat();

    await tick(attachSession);

    // Each is closed and told, once, rather than failing every minute.
    const closed = await Promise.all(waiting.map((row) => readRun(row.id)));
    expect(closed.map((row) => row?.status)).toEqual(
      waiting.map(() => "failed")
    );
    expect(send).toHaveBeenCalledTimes(waiting.length);
    expect(sentText(send.mock.calls[0]?.[0])).toContain(
      "the cloud browser service is not available right now"
    );
    // Closing them took none of the tick's starts: the VM's errand began.
    expect(cloud.created).toHaveLength(1);
    expect(cloud.created[0]?.task).toContain("Полный текст поручения 6");
    expect((await readRun(onVm.id))?.retriedAsRunId).toBe("cloud-run-1");
  }, 30_000);
});

describe("errands on the person's own browser between ticks", () => {
  const ownProfile = `vm:${alice.workspaceId}:p1`;

  /**
   * Start a tick on the fake clock and move the clock a second at a time,
   * letting the real database answer in between, until the tick is over or
   * `until` holds.
   */
  async function tickOnClock(
    attachSession: ScheduleHandlerArgs["attachSession"],
    until: () => boolean = () => false
  ) {
    const finished = { value: false };
    const ticking = tick(attachSession).then(() => {
      finished.value = true;
      return finished.value;
    });
    async function runClock(stepsLeft: number): Promise<void> {
      if (finished.value || until() || stepsLeft === 0) return;
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return runClock(stepsLeft - 1);
    }
    await runClock(90);
    return { finished, ticking };
  }

  async function onFakeClock() {
    // Loaded before the clock is faked: the module runner has timers of its own.
    await import("@agent/schedules/browser-runs");
    liveWatch.value = true;
    vi.useFakeTimers({ now: new Date(), toFake: ["Date", "setTimeout"] });
  }

  it("asks the person's own browser again as soon as it said, Browser Use only after the minute", async () => {
    const { queueRetryAt } = await import("@agent/lib/browser-use/queue");
    const now = new Date("2026-10-04T13:05:00.000Z");
    const waitOf = (options: Parameters<typeof queueRetryAt>[1]) =>
      queueRetryAt(now, options).getTime() - now.getTime();

    // A sandbox being moved onto its host says 15 s; a starting VM 45 s.
    expect(waitOf({ ownBrowser: true, retryAfterMs: 15_000 })).toBe(15_000);
    expect(waitOf({ ownBrowser: true, retryAfterMs: 45_000 })).toBe(45_000);
    expect(waitOf({ ownBrowser: true, retryAfterMs: 2_000 })).toBe(15_000);
    expect(waitOf({ ownBrowser: true })).toBe(15_000);
    // Browser Use's cap, an account held by another errand, a failed start.
    expect(waitOf({ retryAfterMs: 15_000 })).toBe(60_000);
    expect(waitOf({})).toBe(60_000);
    // Nobody waits more than five minutes between tries.
    expect(waitOf({ ownBrowser: true, retryAfterMs: 600_000 })).toBe(300_000);
  });

  it("parks an errand whose own browser is starting for the 15 s it asked, and a Browser Use one for the minute", async () => {
    const own = await queuedErrand(0, undefined, ownProfile);
    const hosted = await queuedErrand(1);
    cloud.nextCreate.push("vm_starting", "busy");
    const { attachSession } = webChat();

    const before = Date.now();
    await tick(attachSession);

    expect(cloud.created).toHaveLength(0);
    const ownRetry = (await readRun(own.id))?.retryAt?.getTime() ?? 0;
    expect(ownRetry - before).toBeGreaterThanOrEqual(15_000);
    expect(ownRetry - Date.now()).toBeLessThanOrEqual(15_000);
    const hostedRetry = (await readRun(hosted.id))?.retryAt?.getTime() ?? 0;
    expect(hostedRetry - before).toBeGreaterThanOrEqual(59_000);
  }, 30_000);

  it("starts an errand 15 s after its own browser asked for them, in the same tick, and only once", async () => {
    await onFakeClock();
    const queued = await queuedErrand(0, undefined, ownProfile);
    // Starting at the tick; up when asked again.
    cloud.nextCreate.push("vm_starting", "ok");
    const tries = new Array<number>();
    const noteTry = () => {
      tries.push(Date.now());
      return Promise.resolve();
    };
    cloud.beforeCreate.push(noteTry, noteTry);
    const { attachSession } = webChat();

    const { finished, ticking } = await tickOnClock(attachSession);
    await ticking;

    expect(finished.value).toBe(true);
    expect(tries).toHaveLength(2);
    const [first = 0, second = 0] = tries;
    // Not the next minute's tick: the live watch, a few seconds late at most.
    expect(second - first).toBeGreaterThanOrEqual(15_000);
    expect(second - first).toBeLessThanOrEqual(20_000);
    expect(cloud.created).toHaveLength(1);
    expect(await readRun(queued.id)).toMatchObject({
      retriedAsRunId: "cloud-run-1",
      status: "stopped",
    });
  }, 60_000);

  it("never starts an errand twice while its start in the live watch is still going", async () => {
    await onFakeClock();
    const queued = await queuedErrand(0, undefined, ownProfile);
    await database
      .update(schema.browserRuns)
      .set({ retryAt: new Date(Date.now() + 10_000) })
      .where(eq(schema.browserRuns.id, queued.id));
    // The start hangs, as a sandbox restore on its host does, until let go.
    const gate = Promise.withResolvers<undefined>();
    cloud.beforeCreate.push(async () => {
      await gate.promise;
    });
    const { attachSession } = webChat();

    const first = await tickOnClock(
      attachSession,
      () => cloud.beforeCreate.length === 0
    );
    expect(cloud.beforeCreate).toHaveLength(0);
    expect(first.finished.value).toBe(false);
    // The next tick finds the errand claimed: neither its queue stage nor
    // its own live watch starts it again.
    await tick(attachSession);
    expect(cloud.created).toHaveLength(0);

    gate.resolve(undefined);
    const rest = await tickOnClock(attachSession);
    await Promise.all([first.ticking, rest.ticking]);

    expect(cloud.created).toHaveLength(1);
    expect(await readRun(queued.id)).toMatchObject({
      retriedAsRunId: "cloud-run-1",
      status: "stopped",
    });
  }, 60_000);

  it("keeps to the tick's start cap across its queue stage and its live watch", async () => {
    await onFakeClock();
    const queued = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(async (index) => {
        const row = await queuedErrand(index, undefined, ownProfile);
        // Each on a site of its own: none waits for another's sign-in.
        await database
          .update(schema.browserRuns)
          .set({ site: `https://shop-${String(index)}.ru` })
          .where(eq(schema.browserRuns.id, row.id));
        return row;
      })
    );
    const { attachSession } = webChat();

    const { ticking } = await tickOnClock(attachSession);
    await ticking;

    // Five started in the queue stage; the sixth, due all along, waits for
    // the next tick rather than starting in the watch.
    expect(cloud.created).toHaveLength(5);
    const last = await readRun(queued[5]?.id ?? "");
    expect(last?.status).toBe("queued");
    expect(last?.retriedAsRunId).toBeNull();
  }, 60_000);

  it("retries an errand walled on its own browser within seconds of the wall", async () => {
    await onFakeClock();
    const runId = `vm:${alice.workspaceId}:r:7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f`;
    const sessionId = `vm:${alice.workspaceId}:s:3f2e1d0c-9b8a-4f7e-a6d5-c4b3a2f1e0d9`;
    cloud.runs.set(runId, {
      result:
        "RESULT: Avito: «Доступ ограничен: проблема с IP»\nNEEDS: captcha",
      sessionId,
      status: "completed",
      task: "Найди велосипед на Авито",
    });
    const { createBrowserRun } = await import("@db/services/browser-runs");
    await createBrowserRun(alice, {
      conversationChannel: "eve",
      conversationId: "web-session",
      createdAt: minutesAgo(3),
      id: runId,
      profileId: ownProfile,
      rootSessionId: "web-session",
      sessionId,
      site: "https://www.avito.ru",
      status: "running",
      task: "Найди велосипед",
      updatedAt: minutesAgo(3),
    });
    const retried = new Array<number>();
    cloud.beforeCreate.push(() => {
      retried.push(Date.now());
      return Promise.resolve();
    });
    const { attachSession, send } = webChat();

    const settledFrom = Date.now();
    const { ticking } = await tickOnClock(attachSession);
    await ticking;

    // The wall was parked with its first retry due at once, and the live
    // watch started it a moment later, not a minute later.
    expect(cloud.created).toHaveLength(1);
    expect(cloud.created[0]?.task).toContain(
      `(Background retry 2 of errand ${runId}; for bookkeeping only.)`
    );
    expect(cloud.created[0]?.sessionId).toBe(sessionId);
    expect((retried[0] ?? Number.POSITIVE_INFINITY) - settledFrom).toBeLessThan(
      10_000
    );
    expect((await readRun(runId))?.retriedAsRunId).toBe("cloud-run-1");
    // The person hears nothing about a wall the retry may get past.
    expect(send).not.toHaveBeenCalled();
  }, 60_000);
});
