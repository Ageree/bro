import { afterEach, describe, expect, it, vi } from "vitest";
import { cardToolsBeforeOutcome } from "@agent/lib/delivery/browser-report";
import { actionsHeldForAnswer } from "@agent/lib/delivery/questions";
import { turnKind } from "@agent/lib/turn-kind/kind";
import {
  agenticWriteTools,
  backgroundTaskTurnTools,
  proactiveReadTools,
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
  const step = { sessionId: "session-1", stepIndex: 0, turnId: "turn_1" };

  it("reads the caller and the turn's opening message", () => {
    expect(turnKind(catalogContext("web"), step)).toBe("person");
    expect(turnKind(catalogContext("telegram"), step)).toBe("person");
    expect(turnKind(catalogContext("browser-report"), step)).toBe(
      "browser-report"
    );
    expect(turnKind(catalogContext("scheduled-worker"), step)).toBe(
      "scheduled-worker"
    );
    expect(turnKind(catalogContext("proactive-worker"), step)).toBe(
      "proactive-worker"
    );
    expect(turnKind(catalogContext("scheduled-report"), step)).toBe(
      "scheduled-report"
    );
  });

  it("tells the task agent's report from the browser report whose caller it keeps", () => {
    expect(
      turnKind(catalogContext("browser-report", [backgroundTask]), step)
    ).toBe("background-task");
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

  it("keeps phone reports read/delivery-only even when browser file preparation is enabled", () => {
    for (const stableContext of [false, true]) {
      const tools = turnTools({
        ...quiet,
        kind: "phone-report",
        browserFiles: true,
        stableContext,
        taskAgent: true,
      });
      expect(tools.offeredTools).toEqual([
        "send_message",
        "react_to_message",
        "phone-status",
        "calculate",
      ]);
      expect(tools.withheldTools).toContain("ask_question");
    }
  });

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

  it("lets the task agent's report offer to sign its file in the signing pilot", () => {
    const report = {
      ...quiet,
      kind: "background-task",
      taskAgent: true,
    } as const;
    expect(turnTools({ ...report, signing: true }).offeredTools).toEqual([
      "sign_document",
      ...backgroundTaskTurnTools,
    ]);
    expect(turnTools(report).offeredTools).toEqual(backgroundTaskTurnTools);
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

describe("the agentic worker's turn", () => {
  const step = { sessionId: "session-1", stepIndex: 0, turnId: "turn_1" };
  // The check of the catalog, marked agentic: its workspace is workspace-1.
  const base = catalogContext("proactive-worker");
  const { current } = base.session.auth;
  const agentic = {
    ...base,
    session: {
      ...base.session,
      auth: {
        current,
        initiator: {
          ...current,
          attributes: { ...current.attributes, scheduledRunKind: "agentic" },
        },
      },
    },
  };

  // The pilot is read from the environment when the module loads.
  async function kindIn(pilot: string) {
    vi.resetModules();
    vi.stubEnv("AGENCY_WORKSPACES", pilot);
    const { turnKind: kindOf } = await import("@agent/lib/turn-kind/kind");
    return kindOf(agentic, step);
  }

  afterEach(() => {
    vi.stubEnv("AGENCY_WORKSPACES", "");
  });

  it("is the agentic worker's kind in its pilot, and the proactive check's outside it", async () => {
    expect(await kindIn("workspace-1")).toBe("agentic-worker");
    expect(await kindIn("workspace-2")).toBe("proactive-worker");
  });

  it("is offered the proactive check's reads, its own reads and the writes it is granted", () => {
    expect(
      turnTools({
        askedQuestion: false,
        cardsHeld: false,
        heldForAnswer: false,
        kind: "agentic-worker",
        reportPastAnswer: false,
        stableContext: false,
        taskAgent: false,
      })
    ).toEqual({
      offeredTools: [
        ...proactiveReadTools,
        "agent-mail-inbox",
        "agent-mail-list",
        "agent-mail-read",
        "calendar-check-availability",
        "contacts-search",
        "list_orders",
        "mail-read",
        "mail-search",
        "phone-status",
        "route_time",
        ...agenticWriteTools,
      ],
      withheldTools: ["task"],
    });
    expect(agenticWriteTools).toEqual([
      "agent-mail-send",
      "browser_task",
      "calendar-create-event",
      "calendar-delete-event",
      "calendar-update-event",
      "gmail-draft",
      "gmail-send",
      "mail-send",
      "phone-call",
    ]);
  });

  it("offers the agentic worker no web page, which an email could steer to a URL of its choice", () => {
    const offered = turnTools({
      askedQuestion: false,
      cardsHeld: false,
      heldForAnswer: false,
      kind: "agentic-worker",
      reportPastAnswer: false,
      stableContext: false,
      taskAgent: false,
    }).offeredTools;
    expect(offered).not.toContain("web_fetch");
    expect(offered).not.toContain("web_search");
  });
});
