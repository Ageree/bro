import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import { TurnTracker } from "../../bench/tracker.ts";
import { recordedEvents } from "./recorded.ts";

const meta = { at: "2026-09-24T12:00:00.000Z", id: "evt_test" };

function turn(turnId: string, events: readonly MessageStreamEvent[]) {
  return [
    { data: { sequence: 0, turnId }, meta, type: "turn.started" },
    ...events,
    { data: { sequence: 0, turnId }, meta, type: "turn.completed" },
  ] satisfies MessageStreamEvent[];
}

function browserResult(status: string): MessageStreamEvent {
  return {
    data: {
      result: {
        callId: `call_${status}`,
        kind: "tool-result",
        output: { runId: "run_1", status },
        toolName: "browser_task",
      },
      sequence: 0,
      status: "completed",
      stepIndex: 1,
      turnId: "turn_0",
    },
    meta,
    type: "action.result",
  };
}

function observeAll(
  tracker: TurnTracker,
  events: readonly MessageStreamEvent[]
) {
  for (const event of events) tracker.observe(event);
}

describe("TurnTracker on recorded turns", () => {
  it("ends a plain answer with nothing pending", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, recordedEvents("uc-mo-split"));

    expect(tracker.pending.size).toBe(0);
    expect(tracker.awaitingBackground()).toBe(false);
    expect(tracker.blocked()).toBeUndefined();
    expect(tracker.productVersion).toBe("eve 0.62.0");
  });

  it("holds an approval card until eve resolves it", () => {
    const events = recordedEvents("uc-ma-event-from-photo");
    const resolvedAt = events.findIndex(
      (event) => event.type === "input.resolved"
    );
    const tracker = new TurnTracker();
    observeAll(tracker, events.slice(0, resolvedAt));

    const [card] = [...tracker.pending.values()];
    expect(card?.kind).toBe("tool-approval");
    expect(card?.action.toolName).toBe("calendar-create-event");
    // An approval is the driver's to answer, not a reason to stop.
    expect(tracker.blocked()).toBeUndefined();

    observeAll(tracker, events.slice(resolvedAt));
    expect(tracker.pending.size).toBe(0);
  });
});

describe("TurnTracker and background errands", () => {
  it("waits for a background turn after a running browser errand", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [browserResult("running")]));
    expect(tracker.awaitingBackground()).toBe(true);

    // The report arrives as a turn nobody sent.
    observeAll(tracker, turn("turn_1", []));
    expect(tracker.awaitingBackground()).toBe(false);
  });

  it("keeps waiting when the background turn starts another run", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [browserResult("running")]));
    observeAll(tracker, turn("turn_1", [browserResult("running")]));

    expect(tracker.awaitingBackground()).toBe(true);
  });

  it("does not wait for an errand that never started", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [browserResult("needs_approval")]));

    expect(tracker.awaitingBackground()).toBe(false);
  });
});

describe("TurnTracker.blocked", () => {
  it("stops at an authorization only a person can pass", () => {
    const tracker = new TurnTracker();
    tracker.observe({
      data: {
        description: "Connect Google",
        name: "google",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      meta,
      type: "authorization.required",
    });

    expect(tracker.blocked()?.[0]).toBe("needs-authorization");
  });

  it("stops at a question for the tester and keeps it for `send`", () => {
    const tracker = new TurnTracker();
    tracker.observe({
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
            prompt: "На какой вокзал?",
            requestId: "req_q",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      meta,
      type: "input.requested",
    });

    expect(tracker.blocked()).toEqual([
      "waiting-for-tester",
      "вопрос: На какой вокзал?",
    ]);
    expect(new TurnTracker([...tracker.pending.values()]).blocked()?.[0]).toBe(
      "waiting-for-tester"
    );
  });
});
