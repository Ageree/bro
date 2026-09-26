import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type MessageStreamEvent } from "eve/client";
import { afterEach, describe, expect, it } from "vitest";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { ownDataTools } from "../../bench/approvals.ts";
import type { BenchCase } from "../../bench/cases.ts";
import {
  continueCase,
  followCase,
  nextCase,
  noteObservation,
  observeCase,
  runCase,
  type DriverSettings,
} from "../../bench/conversation.ts";
import { readRunRecord } from "../../bench/journal.ts";
import type { PlannedStep } from "../../bench/steps.ts";
import { startFakeEve } from "./fake-eve.ts";
import { recordedEvents } from "./recorded.ts";

let stopFake: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stopFake?.();
  stopFake = undefined;
});

const benchCase: BenchCase = {
  cleanup: [],
  group: "test",
  id: "case-under-test",
  needsSetup: [],
  riskLevel: "read-only",
  script: [{ at: "T+0", send: "привет" }],
  suite: "ru",
  title: "Тест драйвера",
};
const step: PlannedStep = {
  at: "T+0",
  files: [],
  manual: undefined,
  newConversation: false,
  text: "привет",
};

async function settingsFor(host: string, backgroundWaitMs = 0) {
  return {
    approvedTools: ownDataTools,
    backgroundWaitMs,
    extraFiles: [],
    heldTools: [],
    hintText: "ну что там?",
    host,
    nudges: 1,
    outDir: await mkdtemp(join(tmpdir(), "bench-run-")),
    paced: false,
    tester: "тест",
    timeZone: "Europe/Moscow",
    turnTimeoutMs: 20_000,
    voice: [],
  } satisfies DriverSettings;
}

let eventNumber = 0;
const meta = () => {
  eventNumber += 1;
  return { at: new Date().toISOString(), id: `evt_${String(eventNumber)}` };
};
const turnId = "turn_0";

const turnStarted = (): MessageStreamEvent => ({
  data: { sequence: 0, turnId },
  meta: meta(),
  type: "turn.started",
});
const sessionWaiting = (): MessageStreamEvent => ({
  data: { continuationToken: "wrun_fake", wait: "next-user-message" },
  meta: meta(),
  type: "session.waiting",
});
const toolResult = (
  toolName: string,
  output: Readonly<Record<string, string>>
): MessageStreamEvent => ({
  data: {
    result: {
      callId: `call_${toolName}`,
      kind: "tool-result",
      output,
      toolName,
    },
    sequence: 0,
    status: "completed",
    stepIndex: 1,
    turnId,
  },
  meta: meta(),
  type: "action.result",
});
const delivered = (text: string) =>
  toolResult("send_message", { kind: "message", text });
const browserRunning = () =>
  toolResult("browser_task", { runId: "run_1", status: "running" });
/** The message a finished errand's outcome arrives as. */
const browserReport = (runId = "run_1"): MessageStreamEvent => ({
  data: {
    message: `${backgroundTurnMarker}\n\nBrowser run ${runId} finished.\n\nOutcome: two trains.`,
    sequence: 0,
    turnId,
  },
  meta: meta(),
  type: "message.received",
});
const turn = (...inner: MessageStreamEvent[]): MessageStreamEvent[] => [
  turnStarted(),
  ...inner,
  {
    data: { sequence: 0, turnId },
    meta: meta(),
    type: "turn.completed",
  },
  sessionWaiting(),
];

describe("runCase against eve's session routes", () => {
  it("answers recorded approval cards and journals every event", async () => {
    const recorded = recordedEvents("uc-ma-event-from-photo");
    const batches: MessageStreamEvent[][] = [[]];
    for (const recordedEvent of recorded) {
      batches.at(-1)?.push(recordedEvent);
      if (recordedEvent.type === "session.waiting") batches.push([]);
    }
    const fake = await startFakeEve(() => batches.shift() ?? []);
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      settings
    );

    expect(
      fake.posts.map((post) => post.inputResponses?.[0]?.optionId)
    ).toEqual([undefined, "approve", "approve"]);
    expect(record.driver.status).toBe("completed");
    expect(record.driver.decisions).toHaveLength(2);
    expect(record.driver.sessions).toEqual([
      { sessionId: "wrun_fake", streamIndex: recorded.length },
    ]);
    const lines = (
      await readFile(
        join(settings.outDir, "case-under-test.events.jsonl"),
        "utf8"
      )
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(recorded.length);
    const log = await readFile(
      join(settings.outDir, "case-under-test.log"),
      "utf8"
    );
    expect(log).toContain("<- Бро: второй раз тоже не прошло");
    await expect(
      readRunRecord(settings.outDir, "case-under-test")
    ).resolves.toMatchObject({ caseId: "case-under-test", score: null });
  });

  it("cancels a payment card", async () => {
    const card: MessageStreamEvent = {
      data: {
        requests: [
          {
            action: {
              callId: "call_pay",
              input: { action: "continue", allowPayment: true },
              kind: "tool-call",
              toolName: "browser_task",
            },
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Approve" },
              { id: "cancel", label: "Cancel" },
            ],
            prompt: "Approve tool call: browser_task",
            requestId: "req_pay",
          },
        ],
        sequence: 0,
        stepIndex: 1,
        turnId,
      },
      meta: meta(),
      type: "input.requested",
    };
    const fake = await startFakeEve((post) =>
      post.inputResponses
        ? turn(
            {
              data: {
                resolutions: [
                  {
                    kind: "tool-approval",
                    outcome: "denied",
                    requestId: "req_pay",
                  },
                ],
                sequence: 0,
                stepIndex: 1,
                turnId,
              },
              meta: meta(),
              type: "input.resolved",
            },
            delivered("ок, не оплачиваю")
          )
        : [turnStarted(), card, sessionWaiting()]
    );
    stopFake = () => fake.close();

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      await settingsFor(fake.url)
    );

    expect(fake.posts[1]?.inputResponses).toEqual([
      { optionId: "cancel", requestId: "req_pay" },
    ]);
    expect(record.driver.decisions[0]).toMatchObject({
      optionId: "cancel",
      tool: "browser_task",
    });
    expect(record.driver.status).toBe("completed");
  });
});

describe("runCase and background errands", () => {
  it("waits for the errand's report without a hint", async () => {
    const fake = await startFakeEve(() =>
      turn(browserRunning(), delivered("запустил"))
    );
    stopFake = () => fake.close();
    setTimeout(() => {
      fake.append(turn(browserReport(), delivered("нашёл два поезда")));
    }, 300);

    const settings = await settingsFor(fake.url, 10_000);
    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      settings
    );

    expect(record.hints).toBe(0);
    expect(record.driver.status).toBe("completed");
    const log = await readFile(
      join(settings.outDir, "case-under-test.log"),
      "utf8"
    );
    expect(log).toContain("<- Бро: нашёл два поезда");
  });

  it("asks «ну что там?» once the wait runs out, as a counted hint", async () => {
    const fake = await startFakeEve((post) =>
      post.message === "ну что там?"
        ? turn(delivered("всё ещё ищу"))
        : turn(browserRunning(), delivered("запустил"))
    );
    stopFake = () => fake.close();

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      await settingsFor(fake.url, 800)
    );

    expect(fake.posts.map((post) => post.message)).toEqual([
      "привет",
      "ну что там?",
    ]);
    expect(record.hints).toBe(1);
    expect(record.driver.turns.map((turnNote) => turnNote.kind)).toEqual([
      "script",
      "hint",
    ]);
    // «всё ещё ищу» is not the report: the case is not done.
    expect(record.driver.status).toBe("timed-out");
    expect(record.driver.backgroundRuns).toEqual(["run_1"]);
  }, 20_000);

  it("keeps waiting after a nudge until the report itself arrives", async () => {
    const fake = await startFakeEve((post) => {
      if (post.message !== "ну что там?") {
        return turn(browserRunning(), delivered("запустил"));
      }
      setTimeout(() => {
        fake.append(turn(browserReport(), delivered("нашёл два поезда")));
      }, 300);
      return turn(delivered("всё ещё ищу"));
    });
    stopFake = () => fake.close();

    const settings = await settingsFor(fake.url, 1500);
    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      settings
    );

    expect(record.hints).toBe(1);
    expect(record.driver.status).toBe("completed");
    expect(record.driver.backgroundRuns).toEqual([]);
    const log = await readFile(
      join(settings.outDir, "case-under-test.log"),
      "utf8"
    );
    expect(log).toContain("<- Бро: нашёл два поезда");
  }, 20_000);
});

describe("followCase", () => {
  it("records a timeout, not completion, when the report never comes", async () => {
    const fake = await startFakeEve(() =>
      turn(browserRunning(), delivered("запустил"))
    );
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const client = new Client({ host: fake.url });
    const first = await runCase(client, benchCase, [step], [], settings);
    expect(first.driver.status).toBe("timed-out");

    const record = await followCase(client, first, {
      ...settings,
      backgroundWaitMs: 500,
    });

    expect(record.driver.status).toBe("timed-out");
    expect(record.driver.statusDetail).toContain("не пришёл");
    expect(record.driver.backgroundRuns).toEqual(["run_1"]);
  }, 20_000);
});

describe("continueCase after a question", () => {
  const question: MessageStreamEvent = {
    data: {
      requests: [
        {
          action: {
            callId: "call_q",
            input: {},
            kind: "tool-call",
            toolName: "ask_question",
          },
          allowFreeform: true,
          kind: "question",
          prompt: "Сохранить их?",
          requestId: "req_q",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId,
    },
    meta: meta(),
    type: "input.requested",
  };
  const answered: MessageStreamEvent = {
    data: {
      resolutions: [
        { kind: "question", outcome: "answered", requestId: "req_q" },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId,
    },
    meta: meta(),
    type: "input.resolved",
  };
  const steps: PlannedStep[] = [
    step,
    { ...step, at: "T+7д", text: "бронь с верандой на субботу" },
    { ...step, at: "T+7д", text: "а в Казани?" },
  ];

  it("sends the rest of the script once the tester answers", async () => {
    // RU 24.09, d13: the case ended «completed» after the answer, and the
    // two later probes were never sent.
    const fake = await startFakeEve((post) => {
      if (post.route === "create")
        return [turnStarted(), question, sessionWaiting()];
      if (post.inputResponses) return turn(answered, delivered("сохранил"));
      return turn(delivered(`ответ на: ${JSON.stringify(post.message)}`));
    });
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const client = new Client({ host: fake.url });

    const first = await runCase(client, benchCase, steps, [], settings);

    expect(first.driver.status).toBe("waiting-for-tester");
    expect(first.driver.remainingSteps.map((each) => each.text)).toEqual([
      "бронь с верандой на субботу",
      "а в Казани?",
    ]);
    // The record on disk carries them to the next `pnpm bench send`.
    const saved = await readRunRecord(settings.outDir, "case-under-test");
    expect(saved.driver.remainingSteps).toHaveLength(2);

    const record = await continueCase(client, saved, settings, {
      code: undefined,
      kind: "answer",
      respond: (pending) =>
        pending.map((request) => ({
          requestId: request.requestId,
          text: "yes",
        })),
      text: "yes",
    });

    expect(fake.posts.map((post) => post.message ?? "(ответ)")).toEqual([
      "привет",
      "(ответ)",
      "бронь с верандой на субботу",
      "а в Казани?",
    ]);
    expect(record.driver.turns.map((turnNote) => turnNote.kind)).toEqual([
      "script",
      "answer",
      "script",
      "script",
    ]);
    expect(record.driver.remainingSteps).toEqual([]);
    expect(record.driver.status).toBe("completed");
  });

  it("does not run the script on for a hint", async () => {
    const fake = await startFakeEve((post) =>
      post.route === "create"
        ? [turnStarted(), question, sessionWaiting()]
        : turn(delivered("жду ответа"))
    );
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const client = new Client({ host: fake.url });
    const first = await runCase(client, benchCase, steps, [], settings);

    const record = await continueCase(client, first, settings, {
      code: undefined,
      kind: "hint",
      respond: () => undefined,
      text: "ну что там?",
    });

    expect(fake.posts.map((post) => post.message)).toEqual([
      "привет",
      "ну что там?",
    ]);
    expect(record.driver.remainingSteps).toHaveLength(2);
  });
});

describe("continueCase", () => {
  it("sends a code into the same conversation and never writes it down", async () => {
    const fake = await startFakeEve((post) =>
      post.route === "create"
        ? turn(delivered("пришли код из смс"))
        : turn(delivered("вошёл, код 481516 принят"))
    );
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const client = new Client({ host: fake.url });
    const first = await runCase(client, benchCase, [step], [], settings);

    const record = await continueCase(client, first, settings, {
      code: "481516",
      kind: "code",
      respond: () => undefined,
      text: "481516",
    });

    expect(fake.posts.at(-1)?.message).toBe("481516");
    expect(record.codesRequested).toBe(1);
    const written = await Promise.all(
      ["events.jsonl", "log", "json"].map((file) =>
        readFile(join(settings.outDir, `case-under-test.${file}`), "utf8")
      )
    );
    for (const text of written) expect(text).not.toContain("481516");
  });
});

describe("paced runs and nextCase", () => {
  const weekLater: PlannedStep[] = [
    step,
    {
      ...step,
      at: "T+7д, новый разговор",
      newConversation: true,
      text: "через неделю",
    },
  ];

  it("stops before a step due in a week and sends it only when asked", async () => {
    const fake = await startFakeEve((post) =>
      turn(delivered(`ответ на: ${JSON.stringify(post.message)}`))
    );
    stopFake = () => fake.close();
    const settings = { ...(await settingsFor(fake.url)), paced: true };
    const client = new Client({ host: fake.url });

    const first = await runCase(client, benchCase, weekLater, [], settings);

    expect(fake.posts.map((post) => post.message)).toEqual(["привет"]);
    expect(first.driver.status).toBe("scheduled");
    expect(first.driver.statusDetail).toContain("«T+7д, новый разговор»");
    expect(first.driver.statusDetail).toContain("pnpm bench next");
    expect(first.driver.remainingSteps.map((each) => each.text)).toEqual([
      "через неделю",
    ]);

    // Not due yet: nothing goes out.
    const waiting = await nextCase(client, first, settings, { early: false });
    expect(fake.posts).toHaveLength(1);
    expect(waiting.driver.status).toBe("scheduled");

    const done = await nextCase(client, waiting, settings, { early: true });
    expect(fake.posts.map((post) => [post.route, post.message])).toEqual([
      ["create", "привет"],
      ["create", "через неделю"],
    ]);
    expect(done.driver.status).toBe("completed");
    expect(done.driver.remainingSteps).toEqual([]);
    expect(done.driver.turns.map((turnNote) => turnNote.at)).toEqual([
      "T+0",
      "T+7д, новый разговор",
    ]);
  });

  it("stays scheduled after a cleanup turn between the steps", async () => {
    const fake = await startFakeEve(() => turn(delivered("ок")));
    stopFake = () => fake.close();
    const settings = { ...(await settingsFor(fake.url)), paced: true };
    const client = new Client({ host: fake.url });
    const first = await runCase(client, benchCase, weekLater, [], settings);

    const record = await continueCase(client, first, settings, {
      code: undefined,
      kind: "cleanup",
      respond: () => undefined,
      text: "удали, что запомнил",
    });

    expect(record.hints).toBe(0);
    expect(record.driver.status).toBe("scheduled");
    expect(record.driver.remainingSteps).toHaveLength(1);
  });

  it("refuses to run the script on past an unanswered question", async () => {
    const question: MessageStreamEvent = {
      data: {
        requests: [
          {
            action: {
              callId: "call_q",
              input: {},
              kind: "tool-call",
              toolName: "ask_question",
            },
            allowFreeform: true,
            kind: "question",
            prompt: "В каком городе?",
            requestId: "req_q",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId,
      },
      meta: meta(),
      type: "input.requested",
    };
    const fake = await startFakeEve(() => [
      turnStarted(),
      question,
      sessionWaiting(),
    ]);
    stopFake = () => fake.close();
    const settings = { ...(await settingsFor(fake.url)), paced: true };
    const client = new Client({ host: fake.url });
    const first = await runCase(client, benchCase, weekLater, [], settings);

    await expect(
      nextCase(client, first, settings, { early: true })
    ).rejects.toThrow(/answer first/u);
  });
});

describe("observeCase", () => {
  const deliveredAt = (text: string, at: string): MessageStreamEvent => ({
    ...delivered(text),
    meta: { at, id: `evt_at_${at}` },
  });

  it("keeps what Bro wrote on its own after the fixtures went in, night flagged", async () => {
    const fake = await startFakeEve(() => []);
    stopFake = () => fake.close();
    fake.append([
      deliveredAt("старое, до засева", "2026-09-24T15:00:00.000Z"),
      deliveredAt("СДЭК задерживает посылку", "2026-09-24T18:40:00.000Z"),
    ]);
    setTimeout(() => {
      // 23:30 in Moscow: a night message.
      fake.append([deliveredAt("не спишь?", "2026-09-24T20:30:00.000Z")]);
    }, 200);
    const settings = await settingsFor(fake.url);
    const client = new Client({ host: fake.url });

    const record = await observeCase(client, benchCase, undefined, settings, {
      channel: "web",
      durationMs: 1200,
      notes: ["T+0: ничего не отправлять, наблюдать"],
      sessionId: "wrun_fake",
      since: new Date("2026-09-24T18:00:00.000Z"),
    });

    expect(fake.posts).toEqual([]);
    expect(record.driver.status).toBe("observing");
    expect(
      record.driver.observations.map((each) => [each.at, each.night, each.text])
    ).toEqual([
      ["2026-09-24T21:40:00+03:00", false, "СДЭК задерживает посылку"],
      ["2026-09-24T23:30:00+03:00", true, "не спишь?"],
    ]);
    expect(record.driver.sessions).toEqual([
      { sessionId: "wrun_fake", streamIndex: 3 },
    ]);

    // Watching again the next morning picks up only what is new.
    fake.append([
      deliveredAt("доброе утро, вот сводка", "2026-09-25T05:00:00.000Z"),
    ]);
    const again = await observeCase(client, benchCase, record, settings, {
      channel: "web",
      durationMs: 0,
      notes: [],
      sessionId: undefined,
      since: new Date(),
    });
    expect(again.driver.observations.map((each) => each.text)).toEqual([
      "СДЭК задерживает посылку",
      "не спишь?",
      "доброе утро, вот сводка",
    ]);
  }, 20_000);

  it("records what the tester pasted from Telegram without sending anything", async () => {
    const settings = await settingsFor("http://127.0.0.1:9");

    const record = await noteObservation(benchCase, undefined, settings, {
      at: new Date("2026-09-25T03:40:00.000Z"),
      channel: "telegram",
      notes: [],
      text: "Регистрация на рейс открыта",
    });

    expect(record.driver.status).toBe("observing");
    expect(record.driver.observations).toEqual([
      {
        at: "2026-09-25T06:40:00+03:00",
        channel: "telegram",
        night: true,
        sessionId: null,
        source: "tester",
        text: "Регистрация на рейс открыта",
      },
    ]);
    const saved = await readRunRecord(settings.outDir, "case-under-test");
    expect(saved.driver.observations).toHaveLength(1);
  });
});
