import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardToolsBeforeOutcome } from "@agent/lib/delivery/browser-report";
import { actionsHeldForAnswer } from "@agent/lib/delivery/questions";
import { browserNoticeTurn, turnKind } from "@agent/lib/turn-kind/kind";
import {
  backgroundNoticeMessage,
  backgroundTurnMarker,
} from "@shared/chat/background-turn";
import {
  agenticWriteTools,
  backgroundTaskTurnTools,
  proactiveReadTools,
  reportTurnCardTools,
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

describe("a web chat's notice of an undelivered report", () => {
  const step = { sessionId: "session-1", stepIndex: 0, turnId: "turn_1" };
  const notice = person(backgroundNoticeMessage("Поручение закончено."));
  const answer = { content: "Готово.", role: "assistant" as const };
  // A report turn that failed on its first step leaves its message unanswered.
  const failedReport = person(
    `${backgroundTurnMarker}\n\nBrowser run run-1 finished.`
  );

  it("calls no model past the browser reports whose turns failed", () => {
    expect(
      browserNoticeTurn(
        noticeContext([answer, failedReport, failedReport, notice])
      )
    ).toBe(true);
  });

  it("leaves a task report beside it, or after it, the task's turn", () => {
    for (const messages of [
      // Coalesced, or left by a turn that failed.
      [answer, backgroundTask, notice],
      // Delivered after it: eve keeps the notice's caller.
      [answer, notice, answer, backgroundTask],
    ]) {
      expect(browserNoticeTurn(noticeContext(messages))).toBe(false);
      expect(turnKind(noticeContext(messages), step)).toBe("background-task");
    }
  });

  it("never passes for the person once its caller outlives it", () => {
    expect(
      turnKind(noticeContext([answer, notice, answer, failedReport]), step)
    ).toBe("background-task");
  });
});

/** A web chat's turn under the notice's caller (`abandoned-notice.ts`). */
function noticeContext(messages: readonly ModelMessage[]) {
  const context = catalogContext("web", messages);
  return {
    ...context,
    session: {
      ...context.session,
      auth: {
        ...context.session.auth,
        current: {
          ...context.session.auth.current,
          authenticator: "browser-notice",
        },
      },
    },
  };
}

function person(content: string) {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign({ content, role: "user" as const }, { kind: "user" });
}

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

  it("holds a Bro ↔ Bro report's turn to telling the owner, whatever the pilots", () => {
    const context = catalogContext("web");
    const report = {
      ...context,
      session: {
        ...context.session,
        auth: {
          ...context.session.auth,
          current: {
            ...context.session.auth.current,
            attributes: {
              ...context.session.auth.current.attributes,
              broReportId: "11111111-1111-4111-8111-111111111111",
              broReportToken: "22222222-2222-4222-8222-222222222222",
            },
            authenticator: "bro-result",
          },
        },
      },
    };
    const kind = turnKind(report, {
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn_1",
    });
    expect(kind).toBe("bro-report");
    for (const stableContext of [false, true]) {
      const tools = turnTools({
        ...quiet,
        browserFiles: true,
        kind,
        stableContext,
        taskAgent: true,
      });
      expect(tools.offeredTools).toEqual([
        "send_message",
        "react_to_message",
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

  it("gives a browser report Bro's cards in its one set only where cards are offered", () => {
    const pilot = {
      ...quiet,
      kind: "browser-report",
      stableContext: true,
    } as const;
    for (const step of [
      turnTools({ ...pilot, cards: true, cardsHeld: true }),
      turnTools({ ...pilot, cards: true }),
    ]) {
      expect(step).toEqual({
        offeredTools: [...reportTurnTools, ...reportTurnCardTools],
        withheldTools: ["ask_question", "task"],
      });
    }
    expect(reportTurnCardTools).toEqual([
      "find_images",
      "send_card",
      "update_card",
      "patch_card",
    ]);
    // Elsewhere the report's block is what it was, byte for byte.
    expect(turnTools({ ...pilot, cards: false }).offeredTools).toEqual(
      reportTurnTools
    );
    expect(reportTurnTools).not.toContain("send_card");
    // A phone call's report keeps its four tools.
    expect(
      turnTools({ ...pilot, cards: true, kind: "phone-report" }).offeredTools
    ).toEqual([
      "send_message",
      "react_to_message",
      "phone-status",
      "calculate",
    ]);
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
    // A new schedule waits for the answer about one like the person's.
    expect(turnTools({ ...pilot, heldRoutine: true })).toEqual({
      withheldTools: ["schedules-create", "task"],
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
