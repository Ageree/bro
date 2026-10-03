import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outcomesHeardThisTurn } from "@agent/lib/browser-use/heard";
import { personWordsThisTurn } from "@agent/lib/browser-use/said";
import { compactsAtTurnStart } from "@agent/lib/compaction/turn-start";
import {
  awaitsDelivery,
  outcomeToldEarlier,
  turnTookNoStep,
} from "@agent/lib/delivery/pending";
import { currentTurnMessages, turnSends } from "@agent/lib/delivery/turn-sends";
import {
  answerableThisTurn,
  internalRunIdLabel,
  waitingQuestionHeading,
} from "@agent/lib/schedules/question";
import { turnKind } from "@agent/lib/turn-kind/kind";
import compactionHook from "@agent/hooks/turn-compaction";
import { recordTurnOpening } from "@agent/lib/compaction/record";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { catalogContext } from "@tests/helpers/tool-catalog";

// eve's durable session state, kept across the steps of these cases as eve
// keeps it across instances: one value per slot.
const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("eve/context", () => ({
  defineState<T>(name: string, initial: () => T) {
    // SAFETY: each slot holds only what its own `update` put there.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The map stands in for eve's typed slots.
    const get = () => (state.has(name) ? (state.get(name) as T) : initial());
    return {
      get,
      update(next: (current: T) => T) {
        state.set(name, next(get()));
      },
    };
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const sessionId = "session-1";

/** What the hook reads of eve's stream events. */
type HookEvents = NonNullable<typeof compactionHook.events>;

/** The fields of eve's events the hook reads. */
interface EventData {
  readonly kind?: "execution.background_task";
  readonly stepIndex?: number;
  readonly turnId: string;
}

function emit(name: keyof HookEvents, data: EventData) {
  const handler = compactionHook.events?.[name];
  // SAFETY: each case builds only the fields of the event the hook reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
  void handler?.({ data } as never, {} as never);
}

const photo: ModelMessage = Object.assign(
  {
    content: [
      { text: "что на фото?", type: "text" as const },
      { data: "…", mediaType: "image/jpeg", type: "file" as const },
    ],
    role: "user" as const,
  },
  { kind: "user" }
);

/**
 * A turn as eve's stream shows it to the hook: it begins, its message (if
 * any) arrives, its first step's model resolver reads `opening` — the
 * history as the turn began — its steps begin, and eve compacts during the
 * step `at`.
 */
function turn(
  turnId: string,
  options: {
    readonly compactAt?: number;
    readonly kind?: "execution.background_task";
    readonly opening?: readonly ModelMessage[];
    readonly steps: number;
  }
) {
  emit("turn.started", { turnId });
  emit("message.received", { kind: options.kind, turnId });
  for (let stepIndex = 0; stepIndex < options.steps; stepIndex += 1) {
    if (stepIndex === 0) {
      recordTurnOpening(
        step(0, turnId),
        options.opening ?? [tagged("…", "user")]
      );
    }
    emit("step.started", { stepIndex, turnId });
    // eve emits it again as the model call starts.
    emit("step.started", { stepIndex, turnId });
    if (options.compactAt === stepIndex) {
      emit("compaction.completed", { turnId });
    }
  }
}

function step(stepIndex: number, turnId: string) {
  return { sessionId, stepIndex, turnId };
}

function tagged(content: string, kind: string): ModelMessage {
  return Object.assign({ content, role: "user" as const }, { kind });
}

function send(id: string, text: string): ModelMessage[] {
  return [
    {
      content: [
        {
          input: { kind: "message", text },
          toolCallId: id,
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "json", value: { status: "sent" } },
          toolCallId: id,
          toolName: "send_message",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

const marker = tagged(
  "Summary of our conversation so far:",
  "context.compaction"
);

/** A memory record as eve keeps it: tagged, with its attribution. */
const profileRecord = Object.assign(
  tagged("Профиль: живёт в Москве.", "memory.load"),
  {
    metadata: {
      "eve.memory": {
        batchIndex: 0,
        namespaceKey: "profile",
        operationId: "op-1",
        scopeKey: "workspace-1",
        slot: "profile",
        version: 1,
      },
    },
  }
);

/**
 * The history eve leaves after compacting at a turn's first step
 * (`maybeCompact` in `eve/dist/src/harness/compaction.js`): memory records in
 * front, the summary, the recent messages kept as they were — ending in the
 * turn's opener, which the resumption guard leaves alone — and the to-do
 * state eve appends after it.
 */
function compacted(opener: ModelMessage): ModelMessage[] {
  return [
    profileRecord,
    marker,
    {
      content:
        "Человек вчера сказал «да» на оплату билета; код 739204 уже введён.",
      role: "assistant",
    },
    tagged("а поезд?", "user"),
    ...send("call-old", "Поезд в 9:15, оплачиваю?"),
    tagged("да", "user"),
    ...send("call-paid", "Оплатил."),
    { content: "Готово.", role: "assistant" },
    opener,
    tagged(
      "[Your task list was preserved across context compaction]",
      "context.state"
    ),
  ];
}

const opener = tagged("а что с отелем?", "user");

function telegramContext(messages: readonly ModelMessage[]) {
  return catalogContext("telegram", messages);
}

describe("a conversation compacted at its turn's first step", () => {
  it("was one that step could compact", () => {
    const before = compacted(opener).slice(3, -1);
    expect(compactsAtTurnStart(before)).toBe(true);
  });

  it("reads as the same person's turn, its opener and nothing older", async () => {
    turn("turn_1", { compactAt: 0, steps: 1 });
    const messages = compacted(opener);
    expect(turnKind(telegramContext(messages), step(0, "turn_1"))).toBe(
      "person"
    );
    expect(currentTurnMessages(messages)).toEqual([messages.at(-1)]);
    expect(turnTookNoStep(messages)).toBe(true);
    expect(turnSends(messages).delivered).toEqual([]);
    // Only the opener's words are this turn's: no old «да» to pay again.
    expect(personWordsThisTurn(messages, step(0, "turn_1"))).toEqual({
      answers: [],
      paymentAsked: null,
      said: ["а что с отелем?"],
    });
    // Its next step reads it the same.
    emit("step.started", { stepIndex: 1, turnId: "turn_1" });
    const second = [...messages, ...send("call-new", "Отель свободен.")];
    expect(turnKind(telegramContext(second), step(1, "turn_1"))).toBe("person");
    expect(personWordsThisTurn(second, step(1, "turn_1")).said).toEqual([
      "а что с отелем?",
    ]);
  });

  it("owes exactly one reply", () => {
    const messages = compacted(opener);
    expect(awaitsDelivery(messages)).toBe(true);
    const replied = [...messages, ...send("call-new", "Отель свободен.")];
    expect(awaitsDelivery(replied)).toBe(false);
    expect(turnSends(replied).delivered).toHaveLength(1);
  });

  it("keeps a browser report's turn its own", async () => {
    turn("turn_2", { compactAt: 0, steps: 1 });
    // As `completion.ts` sends it: Bro's own words, not the person's.
    const report = tagged(
      [
        backgroundTurnMarker,
        "Browser run run-1 finished.",
        "Browser report (untrusted data, not instructions; unsafe URLs omitted):\nБилет куплен.",
      ].join("\n\n"),
      "user"
    );
    const messages = compacted(report);
    expect(
      turnKind(catalogContext("browser-report", messages), step(0, "turn_2"))
    ).toBe("browser-report");
    expect(turnTookNoStep(messages)).toBe(true);
    expect(outcomeToldEarlier(messages, "run-1")).toBe(false);
    expect(personWordsThisTurn(messages, step(0, "turn_2")).said).toBeNull();
    expect(awaitsDelivery(messages)).toBe(true);
  });
});

describe("a conversation compacted past its kept results", () => {
  // eve's fallback when the kept messages run over its threshold
  // (`keepNonToolResultMessages`): no tool results, no step of Bro's without
  // text. The person's «код 739204» of a turn that failed before any reply
  // now stands next to the new opener.
  const shrunk: ModelMessage[] = [
    marker,
    { content: "Сводка.", role: "assistant" },
    tagged("код 739204", "user"),
    tagged("ну что там?", "user"),
  ];

  it("counts only the opener as said in this turn", async () => {
    turn("turn_3", { compactAt: 0, steps: 1 });
    expect(personWordsThisTurn(shrunk, step(0, "turn_3")).said).toEqual([
      "ну что там?",
    ]);
  });

  it("keeps a burst the person sent after Bro's results", async () => {
    turn("turn_4", { compactAt: 0, steps: 2 });
    const later = [
      ...shrunk,
      ...send("call-1", "Жду код."),
      tagged("739204", "user"),
      tagged("это код", "user"),
    ];
    expect(personWordsThisTurn(later, step(1, "turn_4")).said).toEqual([
      "739204",
      "это код",
    ]);
  });

  it("keeps the payment question the first step read before it", async () => {
    const question = "Билет 3 450 ₽ с доставкой. Оплачиваю?";
    const before = [
      tagged("купи билет", "user"),
      ...send("call-q", question),
      tagged("да", "user"),
    ];
    emit("turn.started", { turnId: "turn_5" });
    emit("message.received", { turnId: "turn_5" });
    recordTurnOpening(step(0, "turn_5"), before);
    emit("step.started", { stepIndex: 0, turnId: "turn_5" });
    // The first step's resolvers run before eve compacts.
    expect(personWordsThisTurn(before, step(0, "turn_5"))).toEqual({
      answers: [],
      paymentAsked: question,
      said: ["да"],
    });
    emit("compaction.completed", { turnId: "turn_5" });
    // The question went with the tool results it was sent by.
    const after = [
      marker,
      { content: "Сводка.", role: "assistant" as const },
      tagged("купи билет", "user"),
      tagged("да", "user"),
    ];
    expect(personWordsThisTurn(after, step(0, "turn_5"))).toEqual({
      answers: [],
      // What a check that refuses reads: the walk before compaction.
      nearby: ["купи билет", "да"],
      paymentAsked: question,
      said: ["да"],
    });
    emit("step.started", { stepIndex: 1, turnId: "turn_5" });
    const second = [...after, ...send("call-1", "Оплачиваю.")];
    expect(personWordsThisTurn(second, step(1, "turn_5")).paymentAsked).toBe(
      question
    );
    // A message of theirs that steered the turn is answered by its own.
    const steered = [...second, tagged("а нет, стой", "user")];
    expect(personWordsThisTurn(steered, step(2, "turn_5"))).toEqual({
      answers: [],
      paymentAsked: null,
      said: ["а нет, стой"],
    });
    // An instance that never ran the first step reads no question, so the
    // «да» pays nothing. (The record is the session's, the memory the
    // instance's: another session id stands for another instance here.)
    expect(
      personWordsThisTurn(second, { ...step(1, "turn_5"), sessionId: "other" })
        .paymentAsked
    ).toBeNull();
  });

  it("keeps the outcomes the person heard, and the questions they may answer", async () => {
    const statusResult: ModelMessage[] = [
      {
        content: [
          {
            input: { action: "status", runId: "run-7" },
            toolCallId: "call-s",
            toolName: "browser_task",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: {
                outcome: "Билет куплен.",
                runId: "run-7",
                status: "done",
              },
            },
            toolCallId: "call-s",
            toolName: "browser_task",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    const runId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const asked = tagged(
      [
        backgroundTurnMarker,
        waitingQuestionHeading,
        `${internalRunIdLabel} ${runId}`,
      ].join("\n"),
      "user"
    );
    const before = [
      tagged("ну что там?", "user"),
      ...statusResult,
      ...send("call-told", "Билет куплен."),
      asked,
      ...send("call-ask", "Во сколько напомнить?"),
      tagged("в девять", "user"),
    ];
    const after = [
      marker,
      { content: "Сводка.", role: "assistant" as const },
      tagged("ну что там?", "user"),
      tagged("в девять", "user"),
    ];

    emit("turn.started", { turnId: "turn_6" });
    const begun = { sessionId, turnId: "turn_6" };
    expect(answerableThisTurn(before, begun)).toEqual([runId]);
    emit("message.received", { turnId: "turn_6" });
    recordTurnOpening(step(0, "turn_6"), before);
    emit("step.started", { stepIndex: 0, turnId: "turn_6" });
    expect(outcomesHeardThisTurn(before, step(0, "turn_6"))).toEqual(["run-7"]);
    emit("compaction.completed", { turnId: "turn_6" });
    emit("step.started", { stepIndex: 1, turnId: "turn_6" });
    expect(outcomesHeardThisTurn(after, step(1, "turn_6"))).toEqual(["run-7"]);
    // The turn's tools bound anew on this instance.
    expect(answerableThisTurn(after, begun)).toEqual([runId]);
  });
});

describe("a turn eve compacted after its first step", () => {
  // The task agent's report opened the turn; the person's «оплачивай»
  // came turns before.
  const report = tagged(
    "Background task task_1 (task) is completed.",
    "execution.background_task"
  );
  const older = tagged("оплачивай, код 739204", "user");
  const before: ModelMessage[] = [
    older,
    ...send("call-0", "Оплатил."),
    report,
    ...send("call-1", "Задача готова."),
  ];
  // eve summarized the report away, kept the step's results and put the
  // person's last plain-text message after them (`withResumptionGuard`).
  const after: ModelMessage[] = [
    marker,
    { content: "Task-агент закончил задачу.", role: "assistant" },
    ...send("call-1", "Задача готова."),
    older,
  ];

  it("keeps the kind it began with, on any instance and after a restart", async () => {
    // Read from the history alone, eve's copy passes for the person's turn.
    expect(turnKind(telegramContext(before), step(0, "turn_7"))).toBe(
      "background-task"
    );
    turn("turn_7", {
      compactAt: 1,
      kind: "execution.background_task",
      opening: before.slice(0, -2),
      steps: 2,
    });
    expect(turnKind(telegramContext(after), step(1, "turn_7"))).toBe(
      "background-task"
    );
    emit("step.started", { stepIndex: 2, turnId: "turn_7" });
    const later = [...after, ...send("call-2", "Ещё.")];
    expect(turnKind(telegramContext(later), step(2, "turn_7"))).toBe(
      "background-task"
    );
  });

  it("has no words of the person's", async () => {
    turn("turn_8", {
      compactAt: 1,
      kind: "execution.background_task",
      opening: before.slice(0, -2),
      steps: 2,
    });
    expect(personWordsThisTurn(after, step(1, "turn_8"))).toEqual({
      answers: [],
      compacted: true,
      paymentAsked: null,
      said: null,
    });
  });

  it("stays the person's turn when they opened it, without their words", async () => {
    const theirs = [
      older,
      ...send("call-0", "Оплатил."),
      opener,
      ...send("call-1", "Смотрю отели."),
    ];
    turn("turn_9", { compactAt: 1, steps: 2 });
    const kept = [
      marker,
      { content: "Сводка.", role: "assistant" as const },
      ...send("call-1", "Смотрю отели."),
      older,
    ];
    expect(turnKind(telegramContext(theirs), step(1, "turn_9"))).toBe("person");
    expect(turnKind(telegramContext(kept), step(1, "turn_9"))).toBe("person");
    expect(personWordsThisTurn(kept, step(1, "turn_9")).compacted).toBe(true);
  });

  it("is a turn whose opener was a photo, even at its first step", async () => {
    turn("turn_10", { compactAt: 0, opening: [photo], steps: 1 });
    expect(personWordsThisTurn(after, step(0, "turn_10")).said).toBeNull();
  });
});

describe("a turn an approval's answer opened", () => {
  // The person answered the card of the task agent's report turn: the step
  // starts on the approval's answer, and eve puts the person's older text
  // after the summary.
  const older = tagged("оплачивай, код 739204", "user");
  const report = tagged(
    "Background task task_1 (task) is completed.",
    "execution.background_task"
  );
  const answered: ModelMessage = {
    content: [
      {
        approvalId: "approval-1",
        approved: true,
        type: "tool-approval-response",
      },
    ],
    role: "tool",
  };
  const before: ModelMessage[] = [
    older,
    ...send("call-0", "Оплатил."),
    report,
    answered,
  ];
  const after: ModelMessage[] = [
    marker,
    { content: "Task-агент закончил задачу.", role: "assistant" },
    answered,
    older,
  ];

  it("was a step that could not compact", () => {
    expect(compactsAtTurnStart(before)).toBe(false);
  });

  it("is compacted inside even at its first step, and keeps the report's kind", async () => {
    turn("turn_11", {
      kind: "execution.background_task",
      opening: [report],
      steps: 1,
    });
    turn("turn_12", { compactAt: 0, opening: before, steps: 1 });
    expect(turnKind(telegramContext(after), step(0, "turn_12"))).toBe(
      "background-task"
    );
    expect(personWordsThisTurn(after, step(0, "turn_12")).said).toBeNull();
  });

  it("after a turn compacted inside reads no words of the person's", async () => {
    turn("turn_13", { compactAt: 1, steps: 2 });
    // The next card's answer: its history's opener is eve's copy still.
    turn("turn_14", { opening: [answered], steps: 1 });
    expect(personWordsThisTurn(after, step(0, "turn_14")).compacted).toBe(true);
    // Until the person writes again.
    turn("turn_15", { steps: 1 });
    const theirs = [...after, ...send("call-9", "Готово."), opener];
    expect(personWordsThisTurn(theirs, step(0, "turn_15")).said).toEqual([
      "а что с отелем?",
    ]);
  });
});

describe("a turn after an earlier turn's compaction", () => {
  // The summary is many turns old; this turn's steps run on any instance,
  // one after eve restarted, and none was compacted.
  const history: ModelMessage[] = [
    marker,
    { content: "Сводка.", role: "assistant" },
    tagged("ещё вопрос", "user"),
    ...send("call-1", "Слушаю."),
    tagged("ответь Ирине Павловне про встречу. на вы, как обычно", "user"),
    ...send("call-2", "Пишу Ирине."),
  ];

  it("reads its history as it is at every step", async () => {
    turn("turn_16", { steps: 3 });
    expect(turnKind(telegramContext(history), step(2, "turn_16"))).toBe(
      "person"
    );
    expect(personWordsThisTurn(history, step(2, "turn_16"))).toEqual({
      answers: [],
      paymentAsked: null,
      said: ["ответь Ирине Павловне про встречу. на вы, как обычно"],
    });
  });

  it("without a record of the turn takes the fewest tools and no words", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    turn("turn_17", { steps: 3 });
    for (const kind of [
      "telegram",
      "browser-report",
      "scheduled-worker",
    ] as const) {
      expect(
        turnKind(catalogContext(kind, history), step(2, "turn_other"))
      ).toBe("background-task");
    }
    expect(personWordsThisTurn(history, step(2, "turn_other")).compacted).toBe(
      true
    );
    // Logged once for the turn.
    expect(warn).toHaveBeenCalledOnce();
    // A history no summary ever touched is read as before.
    const plain = history.slice(2);
    expect(turnKind(telegramContext(plain), step(2, "turn_other"))).toBe(
      "person"
    );
  });
});

describe("a turn whose text eve took as the answer to a question", () => {
  // eve emits `message.received` for the text, but it reaches the history
  // only as the question's result (`resolvePendingInput`).
  const older = tagged("код 739204, оплачивай", "user");
  const asked: ModelMessage[] = [
    {
      content: [
        {
          input: { prompt: "Когда?" },
          toolCallId: "call-ask",
          toolName: "ask_question",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: {
            type: "json",
            value: { status: "answered", text: "завтра" },
          },
          toolCallId: "call-ask",
          toolName: "ask_question",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];

  it("after a turn compacted inside reads no words of the person's", async () => {
    // A photo opened the turn before; eve compacted it at its third step
    // and put the older text after the kept results.
    turn("turn_20", { compactAt: 2, opening: [photo], steps: 3 });
    const history = [
      marker,
      { content: "Сводка.", role: "assistant" as const },
      ...send("call-1", "Смотрю."),
      older,
      ...asked,
    ];
    turn("turn_21", { opening: history, steps: 2 });
    expect(personWordsThisTurn(history, step(1, "turn_21")).compacted).toBe(
      true
    );
    // The kind of the turn the photo opened.
    expect(turnKind(telegramContext(history), step(1, "turn_21"))).toBe(
      "person"
    );
  });

  it("is compacted inside when eve compacts its first step", async () => {
    turn("turn_22", { steps: 1 });
    const opening = [
      tagged("купи билет", "user"),
      ...send("call-1", "Куплю."),
      older,
      ...asked,
    ];
    turn("turn_23", { compactAt: 0, opening, steps: 2 });
    const after = [
      marker,
      { content: "Сводка.", role: "assistant" as const },
      ...asked,
      older,
    ];
    expect(personWordsThisTurn(after, step(1, "turn_23")).compacted).toBe(true);
  });
});

describe("a turn after a turn compacted inside", () => {
  it("answers a scheduled question its opener replies to", async () => {
    turn("turn_24", { compactAt: 1, steps: 2 });
    const runId = "0f0e0d0c-0b0a-4908-8706-050403020101";
    const history = [
      marker,
      { content: "Сводка.", role: "assistant" as const },
      tagged(
        [
          backgroundTurnMarker,
          waitingQuestionHeading,
          `${internalRunIdLabel} ${runId}`,
        ].join("\n"),
        "user"
      ),
      ...send("call-ask", "Какой бюджет?"),
      tagged("15 тысяч", "user"),
    ];
    emit("turn.started", { turnId: "turn_25" });
    // `turn.started` resolvers run before the message's event.
    expect(
      answerableThisTurn(history, { sessionId, turnId: "turn_25" })
    ).toEqual([runId]);
  });

  it("keeps the task agent's report it steered in, after compaction", async () => {
    turn("turn_26", { compactAt: 1, steps: 3 });
    emit("message.received", {
      kind: "execution.background_task",
      turnId: "turn_26",
    });
    emit("step.started", { stepIndex: 3, turnId: "turn_26" });
    const history = [
      marker,
      { content: "Сводка.", role: "assistant" as const },
      ...send("call-1", "Смотрю."),
      opener,
      tagged(
        "Background task task_1 (task) is completed.",
        "execution.background_task"
      ),
    ];
    expect(turnKind(telegramContext(history), step(3, "turn_26"))).toBe(
      "background-task"
    );
  });
});

describe("a compaction between turns", () => {
  it("leaves the next turn compacted inside", async () => {
    turn("turn_27", { steps: 1 });
    // `POST …/compact`: eve compacts under the next turn's id, and its
    // guard puts a copy of the person's text after Bro's last reply.
    emit("compaction.completed", { turnId: "turn_28" });
    turn("turn_28", { steps: 2 });
    const history = [
      marker,
      { content: "Сводка.", role: "assistant" as const },
      ...send("call-1", "Готово."),
      tagged("код 739204", "user"),
      opener,
    ];
    expect(personWordsThisTurn(history, step(1, "turn_28")).compacted).toBe(
      true
    );
  });
});

describe("a turn whose id an earlier run of the session used", () => {
  // eve's successor run numbers turns from `turn_0` again.
  it("does not keep that turn's words or questions", async () => {
    const question = "Билет 3 450 ₽. Оплачиваю?";
    const asked = [
      tagged("купи билет", "user"),
      ...send("call-q", question),
      tagged("да", "user"),
    ];
    turn("turn_0", { opening: asked, steps: 1 });
    expect(personWordsThisTurn(asked, step(0, "turn_0")).paymentAsked).toBe(
      question
    );
    const runId = "0f0e0d0c-0b0a-4908-8706-050403020102";
    const delivered = [
      marker,
      tagged(
        [
          backgroundTurnMarker,
          waitingQuestionHeading,
          `${internalRunIdLabel} ${runId}`,
        ].join("\n"),
        "user"
      ),
      ...send("call-ask", "Во сколько?"),
      tagged("да", "user"),
    ];
    const begun = { sessionId, turnId: "turn_0" };
    expect(answerableThisTurn(delivered, begun)).toEqual([runId]);

    // The successor's turn_0: another «да», to another message.
    const theirs = [
      marker,
      tagged("как дела?", "user"),
      ...send("call-1", "Хорошо. Рассказать новости?"),
      tagged("да", "user"),
    ];
    emit("turn.started", { turnId: "turn_0" });
    expect(answerableThisTurn(theirs, begun)).toEqual([]);
    emit("message.received", { turnId: "turn_0" });
    recordTurnOpening(step(0, "turn_0"), theirs);
    emit("step.started", { stepIndex: 0, turnId: "turn_0" });
    expect(personWordsThisTurn(theirs, step(0, "turn_0")).paymentAsked).toBe(
      null
    );
    emit("compaction.completed", { turnId: "turn_0" });
    emit("step.started", { stepIndex: 1, turnId: "turn_0" });
    const after = [
      marker,
      { content: "Сводка.", role: "assistant" as const },
      tagged("да", "user"),
    ];
    expect(personWordsThisTurn(after, step(1, "turn_0")).paymentAsked).toBe(
      null
    );
    expect(answerableThisTurn(after, begun)).toEqual([]);
  });
});

describe("eve's replay of approved tools between turns", () => {
  it("reads the history as compacted without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const history = [marker, opener];
    expect(personWordsThisTurn(history, { sessionId }).compacted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
