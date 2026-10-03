import type { JSONValue, ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { browserReportFraming } from "@agent/lib/delivery/browser-report";
import { eligibleHistory, reportDigest } from "@agent/lib/history/eligible";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

function tagged(content: string, kind: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign({ content, role: "user" as const }, { kind });
}

function person(text: string) {
  return tagged(text, "user");
}

function call(toolName: string, toolCallId: string, input: JSONValue = {}) {
  return {
    content: [{ input, toolCallId, toolName, type: "tool-call" as const }],
    role: "assistant" as const,
  } satisfies ModelMessage;
}

function result(toolName: string, toolCallId: string) {
  return {
    content: [
      {
        output: { type: "text" as const, value: "x".repeat(3000) },
        toolCallId,
        toolName,
        type: "tool-result" as const,
      },
    ],
    role: "tool" as const,
  } satisfies ModelMessage;
}

/** One turn: the person asks, Bro fetches a page under `id`. */
function turn(index: number, id = `call-${String(index)}`): ModelMessage[] {
  return [
    person(`вопрос ${String(index)}`),
    call("web_fetch", id),
    result("web_fetch", id),
  ];
}

function turns(count: number) {
  return Array.from({ length: count }, (_, index) => turn(index)).flat();
}

function ids(count: number, from = 0) {
  return Array.from(
    { length: count },
    (_, index) => `call-${String(from + index)}`
  );
}

function report(runId: string) {
  return [
    backgroundTurnMarker,
    `Browser run ${runId} finished.`,
    browserReportFraming,
    "Result: нашёл три варианта",
  ].join("\n\n");
}

describe("which old history a step may trim", () => {
  it("trims nothing until eight turns stand beyond the four kept", () => {
    expect(eligibleHistory(turns(4))).toBeUndefined();
    expect(eligibleHistory(turns(11))).toBeUndefined();
    expect([...(eligibleHistory(turns(12))?.results ?? [])]).toEqual(ids(8));
  });

  it("moves the cut only at a multiple of eight turns", () => {
    // From 12 to 19 turns the trimmed part is the same, so the prompt only
    // grows at its end and the provider's cache holds.
    for (let count = 12; count < 20; count += 1) {
      expect([...(eligibleHistory(turns(count))?.results ?? [])]).toEqual(
        ids(8)
      );
    }
    expect([...(eligibleHistory(turns(20))?.results ?? [])]).toEqual(ids(16));
    expect([...(eligibleHistory(turns(27))?.results ?? [])]).toEqual(ids(16));
  });

  it("never trims the current turn or the recent ones", () => {
    for (let count = 12; count < 40; count += 1) {
      const trim = eligibleHistory(turns(count));
      for (const id of ids(4, count - 4)) {
        expect(trim?.results.has(id)).toBe(false);
      }
    }
  });

  it("never trims an id the old part holds twice", () => {
    const history = [
      // OpenRouter's hosts numbered each step's calls from `call_0`.
      ...turn(0, "call_0"),
      ...turn(1, "call_0"),
      ...turns(15).slice(6),
    ];
    const trim = eligibleHistory(history);

    expect(trim?.results.has("call_0")).toBe(false);
    expect(trim?.results.has("call-3")).toBe(true);
  });

  it("keeps the set when a later turn uses an old id again", () => {
    // The old part is the same between two moves of the cut; an id a kept
    // turn reuses must not bring its old result back whole.
    const before = eligibleHistory(turns(13));
    const after = eligibleHistory([...turns(13), ...turn(13, "call-3")]);

    expect(before?.results.has("call-3")).toBe(true);
    expect(after?.results).toEqual(before?.results);
  });

  it("never brings back a trimmed result when the cut passes its id again", () => {
    // `call-dup` in turn 2 and again in turn 10. Once the cut takes turn 10
    // in, turn 2's result must stay a trace, or the provider would read the
    // history again from there.
    const history = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        turn(index, index === 2 || index === 10 ? "call-dup" : undefined)
      ).flat();

    for (const count of [12, 19, 20, 27, 28]) {
      expect(eligibleHistory(history(count))?.results.has("call-dup")).toBe(
        true
      );
    }
  });

  it("never trims an id its own batch holds twice, whatever comes after", () => {
    const history = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        turn(index, index === 1 || index === 5 ? "call-twice" : undefined)
      ).flat();

    for (const count of [12, 20, 28]) {
      expect(eligibleHistory(history(count))?.results.has("call-twice")).toBe(
        false
      );
    }
  });

  it("counts the person's messages with no reply between them as one turn", () => {
    // A burst: the person wrote twice before Bro's first step.
    const history = turns(12).flatMap((message, index) =>
      index === 15 ? [person("и ещё"), message] : [message]
    );

    expect([...(eligibleHistory(history)?.results ?? [])]).toEqual(ids(8));
  });

  it("does not count context and memory messages as turns", () => {
    const history = turns(11).flatMap((message, index) =>
      index % 3 === 0
        ? [
            tagged("<profile/>", "memory.load"),
            message,
            tagged("Todo", "context.state"),
            tagged("Retry", "execution.retry"),
          ]
        : [message]
    );

    expect(eligibleHistory(history)).toBeUndefined();
    expect([
      ...(eligibleHistory([...history, ...turn(11)])?.results ?? []),
    ]).toEqual(ids(8));
  });

  it("keeps the set of the turn's first step for the whole turn", () => {
    const step = { sessionId: "session-memo", turnId: "turn_19" };
    const first = eligibleHistory(turns(19), step);
    // A message the person steered into the running turn opens a turn of
    // its own in the history, which would move the cut to 16.
    const steered = [...turns(19), person("и ещё"), ...turn(20).slice(1)];

    expect(eligibleHistory(steered, step)?.results).toEqual(first?.results);
    expect(first?.step).toEqual(step);
    expect([...(eligibleHistory(steered)?.results ?? [])]).toEqual(ids(16));
    // Another session's turn of the same number is its own.
    expect(
      eligibleHistory(steered, {
        sessionId: "session-other",
        turnId: "turn_19",
      })?.results
    ).toEqual(new Set(ids(16)));
  });

  it("counts turns after a compaction's summary", () => {
    const history = [
      tagged("Summary of our conversation so far:", "context.compaction"),
      { content: "Человек спрашивал про погоду.", role: "assistant" as const },
      ...turns(12),
    ];

    expect([...(eligibleHistory(history)?.results ?? [])]).toEqual(ids(8));
  });

  it("takes old browser reports and long errands", () => {
    const old = report("run-old");
    const repeated = report("run-repeated");
    const longTask = "найди билет ".repeat(200);
    const history = [
      person("купи билет"),
      call("browser_task", "call-long", { action: "start", task: longTask }),
      result("browser_task", "call-long"),
      person("и ещё один"),
      call("browser_task", "call-short", { action: "start", task: "коротко" }),
      result("browser_task", "call-short"),
      call("browser_task", "call-json", JSON.stringify({ task: longTask })),
      result("browser_task", "call-json"),
      tagged(old, "user"),
      tagged(repeated, "user"),
      // The task agent's report is a background task's, not a browser's.
      tagged(report("run-task"), "execution.background_task"),
      ...turns(9).slice(3),
      // eve's compaction may put the same report again in the kept turns.
      tagged(repeated, "user"),
      ...turns(12).slice(27),
    ];
    const trim = eligibleHistory(history);

    expect(trim?.inputs).toEqual(new Set(["call-long", "call-json"]));
    // The copy in the kept turns goes whole: `trimPrompt` shortens only the
    // first part with a report's text.
    expect(trim?.openers).toEqual(
      new Set([reportDigest(old), reportDigest(repeated)])
    );
  });
});
