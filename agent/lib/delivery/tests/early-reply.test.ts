import type { JSONValue, ModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import {
  awaitsDelivery,
  headsUpCoversErrand,
  turnDelivered,
} from "@agent/lib/delivery/pending";
import {
  headsUpDelivered,
  headsUpDeliveredNotice,
  opensWithHeadsUp,
  sendRefusal,
  skippedSendNotice,
  turnMessageLimit,
  turnMustEnd,
  turnSends,
} from "@agent/lib/delivery/turn-sends";

/**
 * The early-reply pilot (EARLY_REPLY_WORKSPACES): a person's turn may open
 * with one short heads-up before slow work, and still owes the answer.
 */
const request = "найди крем для рук";
const headsUp = "Сейчас поищу.";

describe("a heads-up outside the early-reply pilot", () => {
  it("goes back for a rewrite, as before", () => {
    const turn = turnSends([person(request)]);

    expect(sendRefusal(message(headsUp), turn)).toEqual({ rewrite: "status" });
    expect(sendRefusal(message(headsUp), turn, false)).toEqual({
      rewrite: "status",
    });
  });

  it("leaves the turn's record as it was", () => {
    const history = [
      person(request),
      ...sendMessage("a", headsUp, textOutput("submitted")),
    ];

    expect(turnSends(history)).toMatchObject({
      delivered: [expect.objectContaining({ text: "сейчас поищу" })],
      headsUpSkips: 0,
      headsUps: [],
    });
    expect(awaitsDelivery(history)).toBe(false);
    expect(turnDelivered(history)).toBe(true);
    expect(headsUpDelivered(textOutput("submitted"))).toBe(false);
  });
});

describe("(a) the heads-up a person's turn opens with", () => {
  it.each(["Сейчас поищу.", "Ищу крем для рук — как найду, пришлю."])(
    "delivers «%s» as written",
    (text) => {
      const turn = turnSends([person(request)]);

      expect(sendRefusal(message(text), turn, true)).toBeUndefined();
      expect(opensWithHeadsUp(message(text), turn)).toBe(true);
    }
  );

  it.each([
    [
      "longer than one short line",
      `Ищу крем для рук — ${"очень ".repeat(20)}скоро пришлю варианты.`,
    ],
    ["on two lines", "Сейчас поищу.\nПришлю, как найду."],
  ])("returns a status %s for a rewrite", (_case, text) => {
    expect(
      sendRefusal(message(text), turnSends([person(request)]), true)
    ).toEqual({ rewrite: "status" });
  });

  it("is no heads-up once work is done or another message went out", () => {
    const searched = [person(request), ...toolStep("web_search", { hits: 0 })];
    const answered = [
      person(request),
      ...sendMessage("a", "Нашёл: Neutrogena за 450 ₽.", textOutput("ok")),
    ];

    expect(opensWithHeadsUp(message(headsUp), turnSends(searched))).toBe(false);
    expect(opensWithHeadsUp(message(headsUp), turnSends(answered))).toBe(false);
  });

  it("is no heads-up in a turn Bro opened", () => {
    const report = tagged(
      "Background task task_1 (task) is completed.\n\nResult:\nГотово.",
      "execution.background_task"
    );

    expect(opensWithHeadsUp(message(headsUp), turnSends([report]))).toBe(false);
  });
});

describe("(b) the person after a heads-up", () => {
  const announced = [
    person(request),
    ...inOneStep(
      sendMessage("a", headsUp, textOutput(headsUpDeliveredNotice)),
      toolStep("web_search", { hits: 3 })
    ),
  ];

  it("still waits, so the next step stays forced", () => {
    expect(headsUpDelivered(textOutput(headsUpDeliveredNotice))).toBe(true);
    expect(awaitsDelivery(announced)).toBe(true);
    expect(turnDelivered(announced)).toBe(false);
    expect(turnMustEnd(announced)).toBe(false);
  });

  it("waits with a quoted reply's note after the heads-up's", () => {
    const quoted = [
      person(request),
      ...sendMessage(
        "a",
        headsUp,
        textOutput(
          `${headsUpDeliveredNotice} Native quoted replies are unavailable on this channel, so it was delivered as an ordinary message.`
        )
      ),
    ];

    expect(awaitsDelivery(quoted)).toBe(true);
  });

  it("stops waiting once the answer went out", () => {
    const answered = [
      ...announced,
      ...sendMessage(
        "b",
        "Нашёл три крема: Neutrogena за 450 ₽, Weleda за 890 ₽ и La Roche-Posay за 1 200 ₽.",
        textOutput("submitted")
      ),
    ];

    expect(awaitsDelivery(answered)).toBe(false);
    expect(turnDelivered(answered)).toBe(true);
  });

  it("counts the heads-up towards the turn's message limit", () => {
    const sends = Array.from({ length: turnMessageLimit - 1 }, (_, index) =>
      sendMessage(
        `answer-${String(index)}`,
        `Вариант номер ${String(index + 1)}: крем за ${String(400 + index * 100)} ₽`,
        textOutput("submitted")
      )
    ).flat();
    const full = [...announced, ...sends];

    expect(turnSends(full).delivered).toHaveLength(turnMessageLimit - 1);
    expect(turnMustEnd(full)).toBe(true);
    expect(
      sendRefusal(message("И ещё один: Nivea за 300 ₽"), turnSends(full), true)
    ).toEqual({ skipped: "limit" });
  });
});

describe("(c) the heads-up said again", () => {
  const announced = [
    person(request),
    ...sendMessage("a", headsUp, textOutput(headsUpDeliveredNotice)),
  ];

  it.each(["Сейчас поищу.", "Ищу, секунду."])(
    "drops «%s» before any work without ending the turn",
    (text) => {
      expect(sendRefusal(message(text), turnSends(announced), true)).toEqual({
        skipped: "heads-up",
      });
      const dropped = [
        ...announced,
        ...sendMessage("b", text, textOutput(skippedSendNotice("heads-up"))),
      ];
      expect(turnSends(dropped)).toMatchObject({
        headsUpSkips: 1,
        skipped: 1,
      });
      expect(turnMustEnd(dropped)).toBe(false);
      expect(awaitsDelivery(dropped)).toBe(true);
    }
  );

  it("drops it even in a step without the pilot's verdict", () => {
    // The turn's record, not the flag, knows a heads-up went out.
    expect(sendRefusal(message("Ищу, секунду."), turnSends(announced))).toEqual(
      { skipped: "heads-up" }
    );
  });

  it("ends the turn when the model keeps saying it instead of working", () => {
    const twice = [
      ...announced,
      ...sendMessage("b", "Ищу.", textOutput(skippedSendNotice("heads-up"))),
      ...sendMessage(
        "c",
        "Ищу, секунду.",
        textOutput(skippedSendNotice("heads-up"))
      ),
    ];

    expect(turnMustEnd(twice)).toBe(true);
  });

  it("drops a copy of it after the work too", () => {
    const searched = [...announced, ...toolStep("web_search", { hits: 3 })];

    expect(sendRefusal(message(headsUp), turnSends(searched), true)).toEqual({
      skipped: "heads-up",
    });
  });

  it.each(["Уже смотрю…"])(
    "drops a bare status «%s» after the work began",
    (text) => {
      const searched = [...announced, ...toolStep("web_search", { hits: 3 })];

      expect(sendRefusal(message(text), turnSends(searched), true)).toEqual({
        skipped: "heads-up",
      });
    }
  );

  it.each(["Смотрю — свободно."])(
    "keeps a short result «%s» that starts with a status word",
    (text) => {
      const searched = [...announced, ...toolStep("web_search", { hits: 3 })];

      expect(
        sendRefusal(message(text), turnSends(searched), true)
      ).toBeUndefined();
    }
  );
});

describe("(d) the answer after a heads-up", () => {
  const silentInbox = "Писем от клиники в почте нет.";

  it("is not dropped as the same status again", () => {
    // The heads-up's result comes after the search's in the step, so had it
    // been an ordinary delivery no work would follow it.
    const announced = [
      person("есть письмо от клиники?"),
      ...inOneStep(
        toolStep("gmail-search", { messages: [] }),
        sendMessage("a", "Смотрю почту.", textOutput(headsUpDeliveredNotice))
      ),
    ];
    const plain = [
      person("есть письмо от клиники?"),
      ...inOneStep(
        toolStep("gmail-search", { messages: [] }),
        sendMessage("a", "Смотрю почту.", textOutput("submitted"))
      ),
    ];

    expect(
      sendRefusal(message(silentInbox), turnSends(announced), true)
    ).toBeUndefined();
    expect(sendRefusal(message(silentInbox), turnSends(plain))).toEqual({
      skipped: "stale",
    });
  });

  // Owner, 14.10: after the heads-up, nothing more until the result.
  it("is dropped as a second message about the browser errand", () => {
    const run = { runId: "run-1", status: "running" };
    const errand = { site: "ozon.ru", task: request };
    const errandMessage =
      "Запустил браузер: ищет крем для рук, пришлю варианты, как найдёт.";
    const announced = [
      person(request),
      ...inOneStep(
        browserStep("start", run, errand),
        sendMessage(
          "a",
          "Секунду, запускаю браузер",
          textOutput(headsUpDeliveredNotice)
        )
      ),
    ];
    const plain = [
      person(request),
      ...inOneStep(
        browserStep("start", run, errand),
        sendMessage("a", "Секунду, запускаю браузер", textOutput("submitted"))
      ),
    ];

    expect(turnSends(announced)).toMatchObject({
      errandTold: false,
      headsUps: [expect.objectContaining({ text: "секунду запускаю браузер" })],
    });
    expect(
      sendRefusal(message(errandMessage), turnSends(announced), true)
    ).toEqual({ skipped: "started" });
    expect(sendRefusal(message(errandMessage), turnSends(plain))).toEqual({
      skipped: "stale",
    });
    expect(awaitsDelivery(announced)).toBe(false);
  });

  it("is judged as the turn's first message, claims and all", () => {
    const announced = [
      person("поставь встречу с Аней на завтра"),
      ...sendMessage("a", "Секунду.", textOutput(headsUpDeliveredNotice)),
    ];

    expect(
      sendRefusal(
        message("Поставил встречу с Аней в календарь на завтра в 15:00."),
        turnSends(announced),
        true
      )
    ).toEqual({ rewrite: "calendar" });
  });
});

describe("(e) a status said again after the browser errand started", () => {
  // Prod, 11.10: without reasoning the model sent three statuses in a row
  // about one errand: the heads-up, then two more.
  const ask = "Найди в интернете, сколько стоит билет на Сапсан завтра";
  const run = { runId: "run-1", status: "running" };
  const errand = { site: "rzd.ru", task: ask };
  const headsUp1 = "Секунду, смотрю цены на завтра.";
  const status2 =
    "Смотрю цены на Сапсан на завтра — пришлю, как соберу варианты.";
  const status3 =
    "Уточни на всякий: завтра — это понедельник, 12 октября. Смотрю цены на Сапсан.";
  const started = [
    person(ask),
    ...inOneStep(
      browserStep("start", run, errand),
      sendMessage("a", headsUp1, textOutput(headsUpDeliveredNotice))
    ),
  ];

  // Owner, 14.10: the heads-up is all, the errand is not told again.
  it("drops the errand's own status after the heads-up", () => {
    expect(sendRefusal(message(status2), turnSends(started), true)).toEqual({
      skipped: "started",
    });
  });

  it("drops a third status that tells nothing the errand's message did not", () => {
    const told = [
      ...started,
      ...sendMessage("b", status2, textOutput("submitted")),
    ];

    expect(sendRefusal(message(status3), turnSends(told), true)).toEqual({
      skipped: "started",
    });
  });

  it("still lets a message with news or a question through", () => {
    const told = [
      ...started,
      ...sendMessage("b", status2, textOutput("submitted")),
    ];

    expect(
      sendRefusal(
        message("На 12 октября есть Сапсан в 08:00 за 3 500 ₽."),
        turnSends(told),
        true
      )
    ).toBeUndefined();
    expect(
      sendRefusal(
        message("Тебе нужен утренний или вечерний рейс?"),
        turnSends(told),
        true
      )
    ).toBeUndefined();
  });

  it("leaves a turn without a heads-up as it was", () => {
    const plain = [
      person(ask),
      ...inOneStep(
        browserStep("start", run, errand),
        sendMessage("a", status2, textOutput("submitted"))
      ),
    ];

    expect(sendRefusal(message(status3), turnSends(plain))).not.toEqual({
      skipped: "started",
    });
  });
});

describe("(f) a heads-up before an errand a browser run took", () => {
  // 14.10: after «Понял — собираю и запускаю» the owner wanted silence, and
  // got «Браузер сейчас занят… встала в очередь… Вернусь со ссылкой».
  const ask = "Запусти мой продукт на Product Radar";
  const errand = { site: "productradar.ru", task: ask };

  it("needs nothing more once the run is at work or queued", () => {
    for (const status of ["running", "queued"]) {
      const handed = [
        person(ask),
        ...sendMessage(
          "a",
          "Понял, приступаю.",
          textOutput(headsUpDeliveredNotice)
        ),
        ...browserStep("start", { runId: "run-1", status }, errand),
      ];

      expect(headsUpCoversErrand(handed)).toBe(true);
      expect(awaitsDelivery(handed)).toBe(false);
    }
  });

  it("drops a second line that only says the run started", () => {
    const handed = [
      person(ask),
      ...sendMessage(
        "a",
        "Сейчас посмотрю на сайте.",
        textOutput(headsUpDeliveredNotice)
      ),
      ...browserStep("start", { runId: "run-1", status: "running" }, errand),
    ];

    expect(
      sendRefusal(
        message(
          "Запустил поиск: смотрю Product Radar, как найду — пришлю итог."
        ),
        turnSends(handed),
        true
      )
    ).toEqual({ skipped: "started" });
    expect(
      sendRefusal(
        message("Запустил. Какой тариф выбрать — бесплатный или платный?"),
        turnSends(handed),
        true
      )
    ).toBeUndefined();
    // An answer to something else the person asked still goes out.
    expect(
      sendRefusal(
        message(
          "Запустил. А публикация на Радаре бесплатная, модерация до 3 дней — пришлю итог."
        ),
        turnSends(handed),
        true
      )
    ).toBeUndefined();
  });

  it("still owes the answer when the run did not take the errand", () => {
    const refused = [
      person(ask),
      ...sendMessage(
        "a",
        "Понял, приступаю.",
        textOutput(headsUpDeliveredNotice)
      ),
      ...browserStep("start", { note: "…", status: "unavailable" }, errand),
    ];
    const noHeadsUp = [
      person(ask),
      ...browserStep("start", { runId: "run-1", status: "queued" }, errand),
    ];

    expect(awaitsDelivery(refused)).toBe(true);
    expect(headsUpCoversErrand(noHeadsUp)).toBe(false);
    expect(awaitsDelivery(noHeadsUp)).toBe(true);
  });
});

function message(text: string) {
  return { kind: "message" as const, text };
}

function textOutput(value: string): ToolResultPart["output"] {
  return { type: "text", value };
}

function person(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return tagged(text, "user");
}

function tagged(content: string, kind: string): ModelMessage {
  return Object.assign({ content, role: "user" as const }, { kind });
}

function sendMessage(
  toolCallId: string,
  text: string,
  output: ToolResultPart["output"]
): ModelMessage[] {
  return [
    {
      content: [
        {
          input: message(text),
          toolCallId,
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { output, toolCallId, toolName: "send_message", type: "tool-result" },
      ],
      role: "tool",
    },
  ];
}

let toolSteps = 0;

function toolStep(
  toolName: string,
  value: Extract<ToolResultPart["output"], { type: "json" }>["value"],
  input: Readonly<Record<string, JSONValue>> = {}
): ModelMessage[] {
  toolSteps += 1;
  const toolCallId = `${toolName}-${String(toolSteps)}`;
  return [
    {
      content: [{ input, toolCallId, toolName, type: "tool-call" }],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "json", value },
          toolCallId,
          toolName,
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

function browserStep(
  action: string,
  value: Extract<ToolResultPart["output"], { type: "json" }>["value"],
  input: Readonly<Record<string, JSONValue>> = {}
): ModelMessage[] {
  return toolStep("browser_task", value, { ...input, action });
}

/**
 * Tool steps whose calls the model made in one step: one assistant message
 * with every call, then one tool message with every result.
 */
function inOneStep(...steps: readonly ModelMessage[][]): ModelMessage[] {
  const stepMessages = steps.flat();
  const calls = stepMessages.flatMap((stepMessage) =>
    stepMessage.role === "assistant" && Array.isArray(stepMessage.content)
      ? stepMessage.content.filter((part) => part.type === "tool-call")
      : []
  );
  const results = stepMessages.flatMap((stepMessage) =>
    stepMessage.role === "tool"
      ? stepMessage.content.filter((part) => part.type === "tool-result")
      : []
  );
  return [
    { content: calls, role: "assistant" },
    { content: results, role: "tool" },
  ];
}
