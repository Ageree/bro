import { describe, expect, it } from "vitest";
import { cardToolsBeforeOutcome } from "@agent/lib/delivery/browser-report";
import { actionsHeldForAnswer } from "@agent/lib/delivery/questions";
import { turnKind } from "@agent/lib/turn-kind/kind";
import {
  backgroundTaskTurnTools,
  reportTurnTools,
} from "@agent/lib/turn-kind/sets";
import { stepIdentity } from "@agent/lib/turn-kind/step";
import { turnTools } from "@agent/lib/turn-kind/tools";
import { catalogContext } from "@tests/helpers/tool-catalog";

/** The opening of a turn that delivers the task agent's report. */
const backgroundTask = Object.assign(
  {
    content:
      "Background task task_1 completed. Use this result to continue helping the user.",
    role: "user" as const,
  },
  { kind: "execution.background_task" }
);

describe("the kind of a turn", () => {
  it("reads the caller and the turn's opening message", () => {
    expect(turnKind(catalogContext("web"))).toBe("person");
    expect(turnKind(catalogContext("telegram"))).toBe("person");
    expect(turnKind(catalogContext("browser-report"))).toBe("browser-report");
    expect(turnKind(catalogContext("scheduled-worker"))).toBe(
      "scheduled-worker"
    );
    expect(turnKind(catalogContext("proactive-worker"))).toBe(
      "proactive-worker"
    );
    expect(turnKind(catalogContext("scheduled-report"))).toBe(
      "scheduled-report"
    );
  });

  it("tells the task agent's report from the browser report whose caller it keeps", () => {
    expect(turnKind(catalogContext("browser-report", [backgroundTask]))).toBe(
      "background-task"
    );
  });
});

describe("the tools of a step", () => {
  const quiet = {
    askedQuestion: false,
    cardsHeld: false,
    heldForAnswer: false,
    reportPastAnswer: false,
    stableContext: false,
    taskAgent: false,
  };

  it("withholds outside the pilot what it withheld before", () => {
    expect(
      turnTools({
        ...quiet,
        cardsHeld: true,
        kind: "browser-report",
        reportPastAnswer: true,
      })
    ).toEqual({
      withheldTools: [
        "ask_question",
        "react_to_message",
        "send_message",
        ...cardToolsBeforeOutcome,
        "task",
      ],
    });
    expect(
      turnTools({ ...quiet, heldForAnswer: true, kind: "person" })
    ).toEqual({ withheldTools: [...actionsHeldForAnswer, "task"] });
    expect(
      turnTools({ ...quiet, kind: "background-task", taskAgent: true })
    ).toEqual({
      offeredTools: backgroundTaskTurnTools,
      withheldTools: [],
    });
  });

  it("gives a browser report one set in the pilot, whatever its step", () => {
    const pilot = {
      ...quiet,
      kind: "browser-report",
      stableContext: true,
    } as const;
    const steps = [
      turnTools({ ...pilot, cardsHeld: true }),
      turnTools(pilot),
      turnTools({ ...pilot, reportPastAnswer: true }),
    ];
    for (const step of steps) {
      expect(step).toEqual({
        offeredTools: reportTurnTools,
        withheldTools: ["ask_question", "task"],
      });
    }
  });

  it("keeps only the question and the held actions as removals in the pilot", () => {
    const pilot = { ...quiet, kind: "person", stableContext: true } as const;
    expect(turnTools(pilot)).toEqual({ withheldTools: ["task"] });
    expect(turnTools({ ...pilot, askedQuestion: true })).toEqual({
      withheldTools: ["ask_question", "task"],
    });
    expect(turnTools({ ...pilot, heldForAnswer: true })).toEqual({
      withheldTools: [...actionsHeldForAnswer, "task"],
    });
    expect(turnTools({ ...pilot, taskAgent: true })).toEqual({
      withheldTools: [],
    });
  });
});

describe("the step a resolver runs for", () => {
  it("reads eve's step.started event, and the session alone without one", () => {
    expect(
      stepIdentity({ data: { stepIndex: 2, turnId: "turn-1" } }, "session-1")
    ).toEqual({ sessionId: "session-1", stepIndex: 2, turnId: "turn-1" });
    expect(stepIdentity({}, "session-1")).toEqual({ sessionId: "session-1" });
  });
});
