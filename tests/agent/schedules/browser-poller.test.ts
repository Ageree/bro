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
  vi,
} from "vitest";
import { z } from "zod";
import * as Database from "@db";
import * as schema from "@db/schema";
import type * as browserUseClient from "@agent/lib/browser-use/client";
import type * as browserUseSecrets from "@agent/lib/browser-use/secrets";
import type * as browserRunsService from "@db/services/browser-runs";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import type { BrowserSubmission } from "@shared/browser/submission";

// The poller runs for real against a real schema: the round-robin take, the
// queue's claim and hand-off, the report lease. Only Browser Use, the
// channels and the owner's Telegram are stand-ins — no live run is started.

interface CloudRun {
  result: string | null;
  sessionId: string;
  status: "completed" | "failed" | "running";
  task: string;
}

const cloud = vi.hoisted(() => ({
  // What happens while Browser Use is starting a run, e.g. a `continue`.
  beforeCreate: new Array<() => Promise<void>>(),
  cancelled: new Array<string>(),
  created: new Array<{ sessionId?: string; task: string }>(),
  // Runs whose status Browser Use keeps failing to answer.
  failing: new Set<string>(),
  // How many times a run's status was asked.
  statusChecks: 0,
  // What the next create answers: a new run, or Browser Use's refusal.
  nextCreate: new Array<"busy" | "down" | "no_credits" | "ok">(),
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
vi.mock("@agent/lib/browser-use/images", () => ({
  captureBrowserRunImages: () => Promise.resolve([]),
}));
// The vault can be made to fail, the way a transient outage does.
const vaultFails = vi.hoisted(() => ({ value: false }));
vi.mock("@agent/lib/browser-use/secrets", async (importOriginal) => ({
  browserSecretAliases: (await importOriginal<typeof browserUseSecrets>())
    .browserSecretAliases,
  resolveBrowserSecretBindings: () =>
    vaultFails.value
      ? Promise.reject(new Error("vault unavailable"))
      : Promise.resolve({ aliases: [], bindings: [] }),
}));
vi.mock("@db/services/orders", () => ({
  recordOrder: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
// The real queue service, except that parking can be made to fail. The live
// watch between ticks is off unless a case turns it on: it sleeps, and only
// the case that drives the clock can wait it out.
const parkFails = vi.hoisted(() => ({ value: false }));
const liveWatch = vi.hoisted(() => ({ value: false }));
vi.mock("@db/services/browser-runs", async (importOriginal) => {
  const original = await importOriginal<typeof browserRunsService>();
  return {
    ...original,
    hasLiveBrowserRuns: () =>
      liveWatch.value ? original.hasLiveBrowserRuns() : Promise.resolve(false),
    parkQueuedBrowserRun: (
      ...args: Parameters<typeof original.parkQueuedBrowserRun>
    ) =>
      parkFails.value
        ? Promise.reject(new Error("connection terminated"))
        : original.parkQueuedBrowserRun(...args),
  };
});
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
    browserUseConfigured: () => true,
    cancelBrowserUseRun: (runId: string) => {
      cloud.cancelled.push(runId);
      return Promise.resolve();
    },
    createBrowserUseRun: async (input: {
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
      if (next === "no_credits") {
        return Promise.reject(
          new original.BrowserUseError(402, "/runs", "Insufficient credits")
        );
      }
      cloud.created.push(input);
      const id = `cloud-run-${String(cloud.created.length)}`;
      const sessionId = `cloud-session-${String(cloud.created.length)}`;
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
      const run = known(runId);
      return Promise.resolve({
        error: null,
        id: runId,
        result: run.result,
        sessionId: run.sessionId,
        status: run.status,
        task: run.task,
      });
    },
    readBrowserUseRunStatus: (runId: string) => {
      cloud.statusChecks += 1;
      return Promise.resolve(known(runId).status);
    },
    stopBrowserUseSessionBrowsers: () => Promise.resolve(0),
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
  cloud.beforeCreate.length = 0;
  cloud.cancelled.length = 0;
  cloud.created.length = 0;
  parkFails.value = false;
  liveWatch.value = false;
  cloud.statusChecks = 0;
  vaultFails.value = false;
  cloud.failing.clear();
  cloud.nextCreate.length = 0;
  cloud.runs.clear();
  alertOwner.mockClear();
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
    expect((await readRun("gosuslugi-run"))?.reportClaimedAt).toBeInstanceOf(
      Date
    );
  }, 30_000);

  it("answers a payment stop with one card, not a question in text", async () => {
    await runningErrand(
      "payment-run",
      [
        "Корзина собрана, дошёл до оплаты.",
        "RESULT: остановился перед оплатой",
        "TOTAL: 2 400 ₽",
        "NEEDS: payment",
      ].join("\n")
    );
    const { attachSession, send } = webChat();

    await tick(attachSession);

    const report = sentText(send.mock.calls[0]?.[0]);
    expect(report).toContain(
      "do not ask in text: continue this run now with allowSubmit and a submission naming exactly the option it staged"
    );
    expect(report).toContain("the real total with every fee in chargeRub");
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

async function queuedErrand(index: number, submission?: BrowserSubmission) {
  const { createQueuedBrowserRun } = await import("@db/services/browser-runs");
  return createQueuedBrowserRun(alice, {
    conversationChannel: "eve",
    conversationId: "web-session",
    createdAt: minutesAgo(10 - index),
    paymentAllowed: false,
    pendingTask: `Полный текст поручения ${String(index)}`,
    profileId: "profile-1",
    retryAt: minutesAgo(1),
    rootSessionId: "web-session",
    site: "https://example.ru",
    submission: submission ?? null,
    task: `Поручение ${String(index)}`,
  });
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
});
