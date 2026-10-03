import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type MessageStreamEvent } from "eve/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
import { connectTimeout, readReset, socketClosed } from "./fetch-failures.ts";
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

async function settingsFor(
  host: string,
  backgroundWaitMs = 0,
  confirmPaymentUpToRub?: number
) {
  return {
    approvedTools: ownDataTools,
    backgroundWaitMs,
    confirmPaymentUpToRub,
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
const failedTurn = (): MessageStreamEvent[] => [
  turnStarted(),
  {
    data: {
      code: "MODEL_CALL_FAILED",
      message: "Provider unavailable",
      sequence: 0,
      turnId,
    },
    meta: meta(),
    type: "turn.failed",
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

  it("holds a payment card for the owner instead of cancelling it (--hold)", async () => {
    const card: MessageStreamEvent = {
      data: {
        requests: [
          {
            action: {
              callId: "call_hold",
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
            requestId: "req_hold",
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
                    outcome: "approved",
                    requestId: "req_hold",
                  },
                ],
                sequence: 0,
                stepIndex: 1,
                turnId,
              },
              meta: meta(),
              type: "input.resolved",
            },
            delivered("оплатил")
          )
        : [turnStarted(), card, sessionWaiting()]
    );
    stopFake = () => fake.close();
    const settings = {
      ...(await settingsFor(fake.url)),
      heldTools: ["browser_task"],
    };
    const client = new Client({ host: fake.url });

    const first = await runCase(client, benchCase, [step], [], settings);

    // Held instead of the default cancel: the owner decides the payment.
    expect(first.driver.status).toBe("waiting-for-tester");
    expect(first.driver.statusDetail).toContain("browser_task");
    expect(first.driver.statusDetail).toContain("pnpm bench send");
    expect(
      first.driver.pendingInputs.map((request) => request.requestId)
    ).toEqual(["req_hold"]);
    const log = await readFile(
      join(settings.outDir, "case-under-test.log"),
      "utf8"
    );
    expect(log).toContain("держит карточку browser_task");
    expect(log).toContain("Approve tool call: browser_task");

    // `pnpm bench send --option approve` answers the held card later.
    const record = await continueCase(client, first, settings, {
      code: undefined,
      kind: "approval",
      respond: (pending) =>
        pending.map((request) => ({
          optionId: "approve",
          requestId: request.requestId,
        })),
      text: "approve",
    });

    expect(fake.posts.at(-1)?.inputResponses).toEqual([
      { optionId: "approve", requestId: "req_hold" },
    ]);
    expect(record.driver.status).toBe("completed");
  });
});

describe("terminal turn failures", () => {
  const steps = [step, { ...step, text: "second" }];

  it("records a failed turn and leaves later scripted steps unsent", async () => {
    const fake = await startFakeEve((post) =>
      post.route === "create" ? failedTurn() : turn(delivered("second"))
    );
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      steps,
      [],
      settings
    );

    expect(record.driver.status).toBe("failed");
    expect(record.driver.statusDetail).toBe(
      "MODEL_CALL_FAILED: Provider unavailable"
    );
    expect(record.driver.remainingSteps.map((item) => item.text)).toEqual([
      "second",
    ]);
    expect(fake.posts).toHaveLength(1);
    expect(
      (await readRunRecord(settings.outDir, benchCase.id)).driver.status
    ).toBe("failed");
  });

  it("does not confuse a recovered step failure with a failed turn", async () => {
    const fake = await startFakeEve((post) =>
      post.route === "create"
        ? turn({
            data: {
              code: "TOOL_FAILED",
              message: "Recovered",
              sequence: 0,
              stepIndex: 0,
              turnId,
            },
            meta: meta(),
            type: "step.failed",
          })
        : turn(delivered("second"))
    );
    stopFake = () => fake.close();
    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      steps,
      [],
      await settingsFor(fake.url)
    );

    expect(record.driver.status).toBe("completed");
    expect(fake.posts).toHaveLength(2);
  });

  it("keeps failure across follow, observe and next until an explicit successful answer", async () => {
    const fake = await startFakeEve((post) =>
      post.route === "create" ? failedTurn() : turn(delivered("recovered"))
    );
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const client = new Client({ host: fake.url });
    const failed = await runCase(client, benchCase, steps, [], settings);
    const followed = await followCase(client, failed, settings);
    expect(followed.driver.status).toBe("failed");
    const observed = await observeCase(client, benchCase, followed, settings, {
      channel: "web",
      durationMs: 0,
      notes: [],
      sessionId: undefined,
      since: new Date(0),
    });
    expect(observed.driver.status).toBe("failed");
    await expect(
      nextCase(client, observed, settings, { early: true })
    ).rejects.toThrow("last turn failed");
    expect(fake.posts).toHaveLength(1);

    const recovered = await continueCase(client, observed, settings, {
      kind: "answer",
      respond: () => undefined,
      text: "try again",
      code: undefined,
    });
    expect(recovered.driver.status).toBe("completed");
    expect(recovered.driver.remainingSteps).toEqual([]);
    expect(fake.posts).toHaveLength(3);
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

  it.each([
    [
      "Письмо от Ozon теперь пришло. Код подтверждения учётных данных из этого письма: 654321. Введи его на сайте",
      "654321",
    ],
    [
      "Это код входа из уведомления Ozon, его нужно ввести на открытой странице: 123 456",
      "123 456",
    ],
  ])(
    "redacts a mixed OTP phrase across a later follow process: %s",
    async (message, code) => {
      const codeAction: MessageStreamEvent = {
        data: {
          actions: [
            {
              callId: "call_code",
              input: {
                personSaid: code,
                task: `Введите ${code.replaceAll(" ", "")} на странице`,
              },
              kind: "tool-call",
              toolName: "browser_task",
            },
          ],
          sequence: 0,
          stepIndex: 1,
          turnId,
        },
        meta: meta(),
        type: "actions.requested",
      };
      const fake = await startFakeEve((post) =>
        post.route === "create"
          ? turn(browserRunning(), delivered("пришли код"))
          : turn(
              {
                data: {
                  message,
                  sequence: 0,
                  turnId,
                },
                meta: meta(),
                type: "message.received",
              },
              codeAction,
              browserRunning()
            )
      );
      stopFake = () => fake.close();
      const settings = await settingsFor(fake.url);
      const client = new Client({ host: fake.url });
      const first = await runCase(client, benchCase, [step], [], settings);
      const continued = await continueCase(client, first, settings, {
        code: undefined,
        kind: "code",
        respond: () => undefined,
        text: message,
      });
      fake.append([codeAction]);
      await followCase(client, continued, {
        ...settings,
        backgroundWaitMs: 50,
      });

      const writtenFiles = await Promise.all(
        ["events.jsonl", "log", "json"].map((extension) =>
          readFile(
            join(settings.outDir, `case-under-test.${extension}`),
            "utf8"
          )
        )
      );
      for (const written of writtenFiles) {
        expect(written).not.toContain(code);
        expect(written).not.toContain(code.replaceAll(" ", ""));
      }
      expect(fake.posts.at(-1)?.message).toBe(message);
    }
  );
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

describe("held cards persist across send (26.09 live bug)", () => {
  it("holds a retried card of the same tool after the tester cancels it, even though send leaves --hold off", async () => {
    const card = (requestId: string): MessageStreamEvent => ({
      data: {
        requests: [
          {
            action: {
              callId: `call_${requestId}`,
              input: { attendees: [], summary: "Dinner with Sam" },
              kind: "tool-call",
              toolName: "calendar-create-event",
            },
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Approve" },
              { id: "cancel", label: "Cancel" },
            ],
            prompt: "Approve tool call: calendar-create-event",
            requestId,
          },
        ],
        sequence: 0,
        stepIndex: 1,
        turnId,
      },
      meta: meta(),
      type: "input.requested",
    });
    const fake = await startFakeEve((post) => {
      if (post.inputResponses) {
        const optionId = post.inputResponses[0]?.optionId;
        if (optionId === "cancel") {
          return [
            {
              data: {
                resolutions: [
                  {
                    kind: "tool-approval",
                    outcome: "denied",
                    requestId: "req_1",
                  },
                ],
                sequence: 0,
                stepIndex: 1,
                turnId,
              },
              meta: meta(),
              type: "input.resolved",
            },
            card("req_2"),
            sessionWaiting(),
          ];
        }
        return turn(delivered("создал"));
      }
      return [turnStarted(), card("req_1"), sessionWaiting()];
    });
    stopFake = () => fake.close();
    const client = new Client({ host: fake.url });
    const settings = {
      ...(await settingsFor(fake.url)),
      heldTools: ["calendar-create-event"],
    };

    const first = await runCase(client, benchCase, [step], [], settings);
    expect(first.driver.status).toBe("waiting-for-tester");

    // `pnpm bench send --option cancel` does not repeat `--hold`.
    const sendSettings = { ...settings, heldTools: [] };
    const record = await continueCase(client, first, sendSettings, {
      code: undefined,
      kind: "approval",
      respond: (pending) =>
        pending.map((request) => ({
          optionId: "cancel",
          requestId: request.requestId,
        })),
      text: "cancel",
    });

    expect(fake.posts.at(-1)?.inputResponses).toEqual([
      { optionId: "cancel", requestId: "req_1" },
    ]);
    // The retried card of the same tool is held, not auto-approved as an
    // own-data tool would be by default.
    expect(record.driver.status).toBe("waiting-for-tester");
    expect(
      record.driver.pendingInputs.map((request) => request.requestId)
    ).toEqual(["req_2"]);
    expect(record.driver.declinedTools).toEqual(["calendar-create-event"]);
    const log = await readFile(
      join(settings.outDir, "case-under-test.log"),
      "utf8"
    );
    expect(log).toContain("тестировщик отменил «calendar-create-event»");
    expect(log).toContain("держит карточку calendar-create-event");
  });
});

describe("driver settings persist across follow", () => {
  it("keeps the run's --hold, --approve and --confirm-payment-up-to after follow leaves them off", async () => {
    const fake = await startFakeEve(() =>
      turn(browserRunning(), delivered("запустил"))
    );
    stopFake = () => fake.close();
    setTimeout(() => {
      fake.append(turn(browserReport(), delivered("нашёл два поезда")));
    }, 300);
    const settings = {
      ...(await settingsFor(fake.url, 0)),
      approvedTools: [...ownDataTools, "gmail-send"],
      confirmPaymentUpToRub: 1000,
      heldTools: ["browser_task"],
    };
    const client = new Client({ host: fake.url });

    const first = await runCase(client, benchCase, [step], [], settings);
    expect(first.driver.status).toBe("timed-out");

    // A later `follow` leaves --hold, --approve and --confirm-payment-up-to
    // off; the record must keep what `run` set for the rest of the case.
    const followSettings = {
      ...settings,
      approvedTools: ownDataTools,
      backgroundWaitMs: 1500,
      confirmPaymentUpToRub: undefined,
      heldTools: [],
    };
    const record = await followCase(client, first, followSettings);

    expect(record.driver.status).toBe("completed");
    const saved = await readRunRecord(settings.outDir, "case-under-test");
    expect(saved.driver.heldTools).toEqual(["browser_task"]);
    expect(saved.driver.approvedTools).toEqual([...ownDataTools, "gmail-send"]);
    expect(saved.driver.confirmPaymentUpToRub).toBe(1000);
  }, 20_000);
});

describe("driver settings persist across next", () => {
  it("reuses the payment cap from the record when next leaves --confirm-payment-up-to off", async () => {
    const paymentCard: MessageStreamEvent = {
      data: {
        requests: [
          {
            action: {
              callId: "call_pay2",
              input: {
                action: "continue",
                allowPayment: true,
                submission: { chargeRub: 900 },
              },
              kind: "tool-call",
              toolName: "browser_task",
            },
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Approve" },
              { id: "cancel", label: "Cancel" },
            ],
            prompt: "Approve tool call: browser_task",
            requestId: "req_pay2",
          },
        ],
        sequence: 0,
        stepIndex: 1,
        turnId,
      },
      meta: meta(),
      type: "input.requested",
    };
    const fake = await startFakeEve((post) => {
      if (post.inputResponses) return turn(delivered("оплатил"));
      if (post.message === "через неделю") {
        return [turnStarted(), paymentCard, sessionWaiting()];
      }
      return turn(delivered("ок"));
    });
    stopFake = () => fake.close();
    const settings = {
      ...(await settingsFor(fake.url)),
      confirmPaymentUpToRub: 1000,
      paced: true,
    };
    const client = new Client({ host: fake.url });
    const weekLaterSteps: PlannedStep[] = [
      step,
      { ...step, at: "T+7д", text: "через неделю" },
    ];

    const first = await runCase(
      client,
      benchCase,
      weekLaterSteps,
      [],
      settings
    );
    expect(first.driver.status).toBe("scheduled");

    // `pnpm bench next` leaves --confirm-payment-up-to off; the cap from
    // `run`'s record must still confirm the payment on the owner's behalf.
    const nextSettings = { ...settings, confirmPaymentUpToRub: undefined };
    const done = await nextCase(client, first, nextSettings, { early: true });

    const paymentDecision = done.driver.decisions.find(
      (decision) => decision.tool === "browser_task"
    );
    expect(paymentDecision).toMatchObject({ optionId: "approve" });
    expect(paymentDecision?.reason).toContain("1000");
    expect(done.driver.status).toBe("completed");
  });
});

const readLog = (outDir: string) =>
  readFile(join(outDir, "case-under-test.log"), "utf8");

const eventIdSchema = z.object({
  event: z.object({ meta: z.object({ id: z.string() }) }),
});

/** The ids of the events the case journaled, in order. */
const journaledIds = async (outDir: string) =>
  (await readFile(join(outDir, "case-under-test.events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => eventIdSchema.parse(JSON.parse(line)).event.meta.id);

/**
 * A stream's answer cut after its first `lines` events, by a reset eve does
 * not reconnect on by itself.
 */
async function cutAfter(response: Response, lines: number) {
  const kept = (await response.text()).split("\n").slice(0, lines);
  let pulls = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            new TextEncoder().encode(kept.map((line) => `${line}\n`).join(""))
          );
        } else {
          controller.error(readReset());
        }
      },
    }),
    { headers: response.headers, status: response.status }
  );
}

describe("a way out to eve that drops requests", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stands in for `fetch`: `handle` answers or fails; `pass` goes on to eve. */
  function interceptFetch(
    handle: (
      url: URL,
      init: RequestInit | undefined,
      pass: () => Promise<Response>
    ) => Promise<Response>
  ) {
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) =>
        await handle(
          new URL(input instanceof Request ? input.url : input),
          init,
          () => realFetch(input, init)
        )
    );
  }

  /**
   * Cuts the first stream read that starts at `startIndex` (null: at the
   * first event) after `lines` events; with `turnOnly`, only a read that
   * follows a turn, not a catch-up read (which asks for the tail index).
   * `onCut` runs once the cut is made. Returns where every stream read
   * started, in order.
   */
  function cutStreamRead(
    startIndex: string | null,
    lines: number,
    options: { readonly turnOnly?: boolean; readonly onCut?: () => void } = {}
  ) {
    const starts: (string | null)[] = [];
    let cut = false;
    interceptFetch(async (url, _init, pass) => {
      const response = await pass();
      if (!url.pathname.endsWith("/stream")) return response;
      const start = url.searchParams.get("startIndex");
      starts.push(start);
      const catchUp = url.searchParams.has("includeTailIndex");
      if (cut || start !== startIndex || (options.turnOnly && catchUp)) {
        return response;
      }
      cut = true;
      options.onCut?.();
      return await cutAfter(response, lines);
    });
    return starts;
  }

  it("opens the conversation again after a connect timeout, once", async () => {
    const fake = await startFakeEve(() => turn(delivered("привет!")));
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    let creates = 0;
    interceptFetch(async (url, init, pass) => {
      if (init?.method === "POST" && url.pathname === "/eve/v1/session") {
        creates += 1;
        if (creates === 1) throw connectTimeout();
      }
      return await pass();
    });

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      settings
    );

    expect(record.driver.status).toBe("completed");
    expect(fake.posts.map((post) => post.route)).toEqual(["create"]);
    expect(creates).toBe(2);
    const log = await readLog(settings.outDir);
    expect(log).toContain(
      "== драйвер: новый разговор: сбой сети (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error"
    );
    expect(log).toContain("повтор через 2 с (1/4)");
    expect(log).toContain("<- Бро: привет!");
  }, 15_000);

  it("does not send a message again once it may have reached Bro", async () => {
    const fake = await startFakeEve(() => turn(delivered("ок")));
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    interceptFetch(async (url, init, pass) => {
      const response = await pass();
      if (
        init?.method === "POST" &&
        url.pathname === "/eve/v1/session/wrun_fake"
      ) {
        // eve took the message; its answer is lost on the way back.
        await response.body?.cancel();
        throw socketClosed();
      }
      return response;
    });

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step, { ...step, text: "второе" }],
      [],
      settings
    );

    expect(fake.posts.map((post) => post.message)).toEqual([
      "привет",
      "второе",
    ]);
    expect(record.driver.status).toBe("failed");
    expect(record.driver.statusDetail).toContain(
      "сообщение сценария: соединение оборвалось, когда запрос уже ушёл (UND_ERR_SOCKET: other side closed), — он мог дойти, и драйвер его не повторяет"
    );
    expect(record.driver.statusDetail).toContain(
      `pnpm bench observe --out ${settings.outDir} --case case-under-test --minutes 0`
    );
    const log = await readLog(settings.outDir);
    expect(log).toContain(
      "!! драйвер: сообщение сценария: соединение оборвалось"
    );
    expect(log).not.toContain("повтор через");
  });

  it("does not open a second conversation when the first may have opened", async () => {
    const fake = await startFakeEve(() => turn(delivered("привет!")));
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    interceptFetch(async (_url, _init, pass) => {
      const response = await pass();
      await response.body?.cancel();
      throw socketClosed();
    });

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      settings
    );

    expect(fake.posts.map((post) => post.route)).toEqual(["create"]);
    expect(record.driver.status).toBe("failed");
    expect(record.driver.statusDetail).toContain(
      "новый разговор: соединение оборвалось, когда запрос уже ушёл"
    );
    expect(record.driver.statusDetail).toContain("«Все чаты» (/chat/history)");
  });

  it("reads the conversation on from its cursor after a dropped stream", async () => {
    const fake = await startFakeEve((post) =>
      turn(delivered(post.route === "create" ? "привет!" : "держу в курсе"))
    );
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const client = new Client({ host: fake.url });
    const first = await runCase(client, benchCase, [step], [], settings);
    const cursor = first.driver.sessions[0]?.streamIndex ?? 0;
    // Bro wrote on its own since the driver last looked.
    fake.append(turn(delivered("поезд нашёлся")));
    // The catch-up read from the cursor breaks after one event.
    const starts = cutStreamRead(String(cursor), 1);

    const record = await continueCase(client, first, settings, {
      code: undefined,
      kind: "hint",
      respond: () => undefined,
      text: "ну что там?",
    });

    expect(record.driver.status).toBe("completed");
    expect(starts.slice(1, 3)).toEqual([String(cursor), String(cursor + 1)]);
    // Every event once, in order: the read went on where it broke.
    expect(await journaledIds(settings.outDir)).toEqual(
      fake.events.map((event) => event.meta.id)
    );
    const log = await readLog(settings.outDir);
    expect(log.split("<- Бро: поезд нашёлся")).toHaveLength(2);
    expect(log).toContain(
      "== драйвер: чтение разговора: сбой сети (ECONNRESET: read ECONNRESET) — повтор через 2 с (1/4)"
    );
  }, 15_000);

  it("remembers past codes on from where a cut read stopped", async () => {
    const fake = await startFakeEve((post) =>
      turn(delivered(post.route === "create" ? "привет!" : "держу в курсе"))
    );
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const client = new Client({ host: fake.url });
    const first = await runCase(client, benchCase, [step], [], settings);
    // `send` first reads the history from its start for the codes in it.
    const starts = cutStreamRead(null, 1);

    const record = await continueCase(client, first, settings, {
      code: undefined,
      kind: "hint",
      respond: () => undefined,
      text: "ну что там?",
    });

    expect(record.driver.status).toBe("completed");
    expect(starts.slice(0, 2)).toEqual([null, "1"]);
  }, 15_000);

  it("watches a conversation on from where a cut read stopped", async () => {
    const fake = await startFakeEve(() => []);
    stopFake = () => fake.close();
    fake.append(
      turn(delivered("рейс в 9:40"), delivered("регистрация открыта"))
    );
    const settings = await settingsFor(fake.url);
    // The first read of a conversation never read before breaks after
    // `turn.started` and the first message.
    const starts = cutStreamRead(null, 2);

    const record = await observeCase(
      new Client({ host: fake.url }),
      benchCase,
      undefined,
      settings,
      {
        channel: "web",
        durationMs: 0,
        notes: [],
        sessionId: "wrun_fake",
        since: new Date(0),
      }
    );

    expect(starts.slice(0, 2)).toEqual([null, "2"]);
    expect(record.driver.observations.map((item) => item.text)).toEqual([
      "рейс в 9:40",
      "регистрация открыта",
    ]);
    expect(await journaledIds(settings.outDir)).toEqual(
      fake.events.map((event) => event.meta.id)
    );
  }, 15_000);

  it("reads an accepted turn on from the cursor when its stream breaks", async () => {
    const fake = await startFakeEve(() =>
      turn(delivered("привет!"), delivered("чем помочь?"))
    );
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const starts = cutStreamRead(null, 2);

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      settings
    );

    expect(record.driver.status).toBe("completed");
    expect(fake.posts.map((post) => post.route)).toEqual(["create"]);
    expect(starts.slice(0, 2)).toEqual([null, "2"]);
    expect(await journaledIds(settings.outDir)).toEqual(
      fake.events.map((event) => event.meta.id)
    );
    const log = await readLog(settings.outDir);
    expect(log).toContain("<- Бро: чем помочь?");
    expect(log).toContain(
      "== драйвер: чтение разговора: сбой сети (ECONNRESET: read ECONNRESET) — повтор через 2 с (1/4)"
    );
  }, 15_000);

  it("fails without sending again when an accepted turn cannot be read", async () => {
    const fake = await startFakeEve(() => turn(delivered("привет!")));
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    interceptFetch(async (url, _init, pass) =>
      url.pathname.endsWith("/stream")
        ? new Response("unauthorized", { status: 401 })
        : await pass()
    );

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      settings
    );

    expect(fake.posts.map((post) => post.route)).toEqual(["create"]);
    expect(record.driver.status).toBe("failed");
    expect(record.driver.statusDetail).toContain(
      "новый разговор: eve его принял, но ход Бро не дочитан"
    );
    expect(record.driver.statusDetail).toContain(
      `сообщение принято, не отправляйте его заново; что ответил Бро, дочитать без отправки: pnpm bench observe --out ${settings.outDir} --case case-under-test --minutes 0`
    );
    // `observe` can pick the conversation up: its cursor is in the record.
    expect(record.driver.sessions).toEqual([
      { sessionId: "wrun_fake", streamIndex: 0 },
    ]);
  });

  it("reads an accepted turn on past a background turn that landed first", async () => {
    const fake = await startFakeEve((post) => {
      if (post.route === "create") return turn(delivered("привет!"));
      // A browser report's turn lands between the cursor and the hint's.
      fake.append(turn(delivered("отчёт поручения")));
      return turn(delivered("вот что нашёл"));
    });
    stopFake = () => fake.close();
    // Short enough that a read that never stops fails the test in time.
    const settings = { ...(await settingsFor(fake.url)), turnTimeoutMs: 8000 };
    const client = new Client({ host: fake.url });
    const first = await runCase(client, benchCase, [step], [], settings);
    const cursor = first.driver.sessions[0]?.streamIndex ?? 0;
    // The hint's own stream breaks inside the background turn, before any
    // event of the hint's turn.
    cutStreamRead(String(cursor), 1, { turnOnly: true });

    const record = await continueCase(client, first, settings, {
      code: undefined,
      kind: "hint",
      respond: () => undefined,
      text: "ну что там?",
    });

    expect(record.driver.status).toBe("completed");
    const hintTurn = fake.events.filter(
      (event) => event.meta.deliveryIds !== undefined
    );
    expect(hintTurn).toHaveLength(4);
    const journaled = await journaledIds(settings.outDir);
    for (const event of hintTurn) expect(journaled).toContain(event.meta.id);
    expect(new Set(journaled).size).toBe(journaled.length);
    expect(await readLog(settings.outDir)).toContain("<- Бро: вот что нашёл");
  }, 20_000);

  it("waits out an accepted turn that goes quiet for longer than eve's idle reconnects", async () => {
    const restOfTheTurn = [
      delivered("готово, три варианта"),
      { data: { sequence: 0, turnId }, meta: meta(), type: "turn.completed" },
      sessionWaiting(),
    ] satisfies MessageStreamEvent[];
    const fake = await startFakeEve(() => [
      turnStarted(),
      delivered("секунду, ищу"),
    ]);
    stopFake = () => fake.close();
    const settings = {
      ...(await settingsFor(fake.url)),
      turnTimeoutMs: 60_000,
    };
    // eve's default gives up on a quiet stream after five empty reconnects,
    // about 8 s; Bro answers after 12.
    cutStreamRead(null, 2, {
      onCut: () => {
        setTimeout(() => {
          fake.append(restOfTheTurn);
        }, 12_000);
      },
    });

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      settings
    );

    expect(record.driver.status).toBe("completed");
    expect(await readLog(settings.outDir)).toContain(
      "<- Бро: готово, три варианта"
    );
    expect(await journaledIds(settings.outDir)).toEqual(
      fake.events.map((event) => event.meta.id)
    );
  }, 45_000);

  it("does not take a turn read on past its deadline for a finished one", async () => {
    const fake = await startFakeEve(() => [
      turnStarted(),
      delivered("секунду, ищу"),
    ]);
    stopFake = () => fake.close();
    const settings = { ...(await settingsFor(fake.url)), turnTimeoutMs: 6000 };
    cutStreamRead(null, 2);

    const record = await runCase(
      new Client({ host: fake.url }),
      benchCase,
      [step],
      [],
      settings
    );

    // The boundary never came: the turn is not over, whatever was read.
    expect(record.driver.status).toBe("timed-out");
    expect(record.driver.statusDetail).toBe("No turn boundary within 6 s.");
  }, 20_000);

  it("recovers a failed case when the cut came after the turn completed", async () => {
    const fake = await startFakeEve((post) =>
      post.route === "create" ? failedTurn() : turn(delivered("получилось"))
    );
    stopFake = () => fake.close();
    const settings = await settingsFor(fake.url);
    const client = new Client({ host: fake.url });
    const failed = await runCase(client, benchCase, [step], [], settings);
    expect(failed.driver.status).toBe("failed");
    const cursor = failed.driver.sessions[0]?.streamIndex ?? 0;
    // The answer's stream breaks after `turn.completed`, before the
    // boundary: the read on from the cursor sees only `session.waiting`.
    cutStreamRead(String(cursor), 3, { turnOnly: true });

    const record = await continueCase(client, failed, settings, {
      code: undefined,
      kind: "answer",
      respond: () => undefined,
      text: "попробуй ещё раз",
    });

    expect(record.driver.status).toBe("completed");
    expect(await readLog(settings.outDir)).toContain(
      "== драйвер: чтение разговора: сбой сети (ECONNRESET: read ECONNRESET)"
    );
  }, 15_000);
});
