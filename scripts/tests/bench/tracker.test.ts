import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
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

function browserResult(
  output: Readonly<Record<string, string>>,
  callId = `call_${output.status ?? "x"}`
): MessageStreamEvent {
  return {
    data: {
      result: {
        callId,
        kind: "tool-result",
        output: { runId: "run_1", ...output },
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

function browserCall(
  callId: string,
  input: Readonly<Record<string, string>>
): MessageStreamEvent {
  return {
    data: {
      actions: [{ callId, input, kind: "tool-call", toolName: "browser_task" }],
      sequence: 0,
      stepIndex: 1,
      turnId: "turn_0",
    },
    meta,
    type: "actions.requested",
  };
}

/** The message a finished errand's outcome arrives as. */
function browserReport(runId: string): MessageStreamEvent {
  return {
    data: {
      message: `${backgroundTurnMarker}\n\nBrowser run ${runId} finished.\n\nOutcome: done.`,
      sequence: 0,
      turnId: "turn_1",
    },
    meta,
    type: "message.received",
  };
}

const said = (message: string): MessageStreamEvent => ({
  data: { message, sequence: 0, turnId: "turn_1" },
  meta,
  type: "message.received",
});

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
  const running = (runId = "run_1") =>
    browserResult({ runId, status: "running" }, `call_${runId}`);

  it("waits for the errand's report after a running browser errand", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [running()]));
    expect(tracker.awaitingBackground()).toBe(true);

    observeAll(tracker, turn("turn_1", [browserReport("run_1")]));
    expect(tracker.awaitingBackground()).toBe(false);
  });

  it("keeps waiting through a nudge or a tester's turn that is not the report", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [running()]));
    observeAll(tracker, turn("turn_1", [said("ну что там?")]));
    observeAll(tracker, turn("turn_2", [said("в казани")]));

    expect(tracker.awaitingBackground()).toBe(true);
    expect(tracker.backgroundRuns()).toEqual(["run_1"]);
  });

  it("waits for every errand started in parallel", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [running("run_1"), running("run_2")]));
    observeAll(tracker, turn("turn_1", [browserReport("run_2")]));
    expect(tracker.awaitingBackground()).toBe(true);

    observeAll(tracker, turn("turn_2", [browserReport("run_1")]));
    expect(tracker.awaitingBackground()).toBe(false);
  });

  it("keeps waiting when the report turn starts a follow-up run", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [running()]));
    observeAll(
      tracker,
      turn("turn_1", [
        browserReport("run_1"),
        browserResult(
          { previousRunId: "run_1", runId: "run_2", status: "running" },
          "call_follow_up"
        ),
      ])
    );

    expect(tracker.backgroundRuns()).toEqual(["run_2"]);
  });

  it("takes a report from a background retry for the errand it continues", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [running()]));
    observeAll(tracker, turn("turn_1", [browserReport("run_retry")]));

    expect(tracker.awaitingBackground()).toBe(false);
  });

  it("follows `status` to the errand's newest run", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [running()]));
    observeAll(
      tracker,
      turn("turn_1", [
        browserCall("call_status", { action: "status", runId: "run_1" }),
        browserResult({ runId: "run_retry", status: "running" }, "call_status"),
      ])
    );
    expect(tracker.backgroundRuns()).toEqual(["run_retry"]);

    observeAll(tracker, turn("turn_2", [browserReport("run_retry")]));
    expect(tracker.awaitingBackground()).toBe(false);
  });

  it("stops waiting for a cancelled errand or one `status` reported", () => {
    const tracker = new TurnTracker();
    observeAll(tracker, turn("turn_0", [running("run_1"), running("run_2")]));
    observeAll(
      tracker,
      turn("turn_1", [
        browserResult({ runId: "run_1", status: "stopped" }, "call_cancel"),
        browserResult({ runId: "run_2", status: "completed" }, "call_status"),
      ])
    );

    expect(tracker.awaitingBackground()).toBe(false);
  });

  it("waits for a queued errand too", () => {
    const tracker = new TurnTracker();
    observeAll(
      tracker,
      turn("turn_0", [browserResult({ runId: "queued:1", status: "queued" })])
    );

    expect(tracker.awaitingBackground()).toBe(true);
  });

  it("does not wait for an errand that never started", () => {
    const tracker = new TurnTracker();
    observeAll(
      tracker,
      turn("turn_0", [browserResult({ status: "needs_approval" })])
    );

    expect(tracker.awaitingBackground()).toBe(false);
  });

  it("keeps the errands a saved record still waits for", () => {
    const tracker = new TurnTracker([], ["run_1"]);
    tracker.expectBackground();
    observeAll(tracker, turn("turn_1", [said("ну что там?")]));

    expect(tracker.awaitingBackground()).toBe(true);
  });

  it("follows a session with no errand on record until the next report", () => {
    const tracker = new TurnTracker();
    tracker.expectBackground();
    expect(tracker.awaitingBackground()).toBe(true);

    observeAll(tracker, turn("turn_1", [browserReport("run_9")]));
    expect(tracker.awaitingBackground()).toBe(false);
  });
});

describe("TurnTracker and a failed turn", () => {
  const credits =
    "This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 24969. To increase, visit https://openrouter.ai/settings/credits and add more credits";
  const stepFailed = (): MessageStreamEvent => ({
    data: {
      code: "MODEL_CALL_FAILED",
      message: credits,
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_0",
    },
    meta,
    type: "step.failed",
  });
  const turnFailed = (): MessageStreamEvent => ({
    data: {
      code: "MODEL_CALL_FAILED",
      message: credits,
      sequence: 2,
      turnId: "turn_0",
    },
    meta,
    type: "turn.failed",
  });

  it("keeps the turn.failed code and message, and a later completed turn clears it", () => {
    const tracker = new TurnTracker();
    tracker.observe(stepFailed());
    expect(tracker.turnFailure).toBeUndefined();

    tracker.observe(turnFailed());
    expect(tracker.turnFailure).toEqual({
      code: "MODEL_CALL_FAILED",
      message: credits,
    });

    observeAll(tracker, turn("turn_1", [said("ок")]));
    expect(tracker.turnFailure).toBeUndefined();
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
