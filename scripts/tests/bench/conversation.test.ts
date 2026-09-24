import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type MessageStreamEvent } from "eve/client";
import { afterEach, describe, expect, it } from "vitest";
import { ownDataTools } from "../../bench/approvals.ts";
import type { BenchCase } from "../../bench/cases.ts";
import {
  continueCase,
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
    hintText: "ну что там?",
    host,
    nudges: 1,
    outDir: await mkdtemp(join(tmpdir(), "bench-run-")),
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
      fake.append(turn(delivered("нашёл два поезда")));
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
  }, 20_000);
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
