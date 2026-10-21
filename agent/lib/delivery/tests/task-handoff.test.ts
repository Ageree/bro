import type { JSONValue, ModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import { taskHandoff } from "@agent/lib/delivery/task-handoff";
import {
  headsUpDeliveredNotice,
  rewriteSendNotice,
  skippedSendNotice,
} from "@agent/lib/delivery/turn-sends";

/**
 * 21.10, prod: after `task` answered «working» the model wrote a second
 * message with a result nobody had seen («Пятёрочка на Мичуринском, 56…
 * собрал два файла», «в архиве Family.jpg»). Once the person knows the work
 * was taken, the turn ends.
 */
const request = "сделай из этого чека таблицу расходов";
const working = { agentId: "ag_task:1", status: "working", taskId: "task_1" };

describe("a turn that handed work to the task agent", () => {
  it("is at work once the call answered «working», and not told yet", () => {
    expect(taskHandoff([person(request), ...taskStep(working)])).toEqual({
      atWork: true,
      told: false,
    });
  });

  it("is told once a message reached the person after the call", () => {
    const history = [
      person(request),
      ...taskStep(working),
      ...sendMessage("a", "Взял чек в работу — пришлю таблицу файлом.", sent),
    ];

    expect(taskHandoff(history)).toEqual({ atWork: true, told: true });
  });

  it("leaves the step after a heads-up sent with the call free for the rest", () => {
    const withCall = [
      person(request),
      ...inOneStep(
        sendMessage("a", "Секунду, разберу чек.", headsUp),
        taskStep(working)
      ),
    ];

    expect(taskHandoff(withCall)).toEqual({ atWork: true, told: false });
    // The message of the step after it is the one that tells.
    expect(
      taskHandoff([...withCall, ...sendMessage("b", "Взял, пришлю.", sent)])
    ).toEqual({ atWork: true, told: true });
  });

  it("owes a second call its own message", () => {
    const history = [
      person(request),
      ...taskStep(working),
      ...sendMessage("a", "Взял чек в работу.", sent),
      ...taskStep(working),
    ];

    expect(taskHandoff(history)).toEqual({ atWork: true, told: false });
  });

  it("is not told by a message that went out before the call", () => {
    const history = [
      person(request),
      ...sendMessage("a", "Секунду, разберу чек.", headsUp),
      ...taskStep(working),
    ];

    expect(taskHandoff(history)).toEqual({ atWork: true, told: false });
  });

  it("is not told by a send that was dropped or sent back", () => {
    const after = (output: ToolResultPart["output"]) =>
      taskHandoff([
        person(request),
        ...taskStep(working),
        ...sendMessage("a", "Взял чек.", output),
      ]);

    expect(after(textOutput(skippedSendNotice("duplicate")))).toEqual({
      atWork: true,
      told: false,
    });
    expect(after(textOutput(rewriteSendNotice("status")))).toEqual({
      atWork: true,
      told: false,
    });
  });

  it("is not at work when the call failed or the work already ended", () => {
    expect(
      taskHandoff([
        person(request),
        ...taskStep({ agentId: "ag_task:1", status: "completed" }),
      ])
    ).toEqual({ atWork: false, told: false });
    expect(
      taskHandoff([
        person(request),
        ...sendMessage("a", "Вот твоя таблица.", sent),
      ])
    ).toEqual({ atWork: false, told: false });
  });

  it("leaves an earlier turn's call alone", () => {
    const history = [
      person("сделай презентацию"),
      ...taskStep(working),
      ...sendMessage("a", "Взялся.", sent),
      person("а сколько будет 17 на 23?"),
      ...sendMessage("b", "391.", sent),
    ];

    expect(taskHandoff(history)).toEqual({ atWork: false, told: false });
  });

  it("reads a result kept as text too", () => {
    const history = [
      person(request),
      ...taskStepWith(textOutput(JSON.stringify(working))),
    ];

    expect(taskHandoff(history).atWork).toBe(true);
  });
});

const sent = textOutput("The message was submitted to the active channel.");
const headsUp = textOutput(headsUpDeliveredNotice);

function textOutput(value: string): ToolResultPart["output"] {
  return { type: "text", value };
}

function person(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
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
          input: { kind: "message", text },
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

let steps = 0;

function taskStep(value: JSONValue): ModelMessage[] {
  return taskStepWith({ type: "json", value });
}

function taskStepWith(output: ToolResultPart["output"]): ModelMessage[] {
  steps += 1;
  const toolCallId = `task-${String(steps)}`;
  return [
    {
      content: [
        {
          input: { message: "Собери таблицу расходов по чеку." },
          toolCallId,
          toolName: "task",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [{ output, toolCallId, toolName: "task", type: "tool-result" }],
      role: "tool",
    },
  ];
}

/** Calls the model made in one step: one assistant message, one tool message. */
function inOneStep(...group: readonly ModelMessage[][]): ModelMessage[] {
  const messages = group.flat();
  const calls = messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "tool-call")
      : []
  );
  const results = messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter((part) => part.type === "tool-result")
      : []
  );
  return [
    { content: calls, role: "assistant" },
    { content: results, role: "tool" },
  ];
}
