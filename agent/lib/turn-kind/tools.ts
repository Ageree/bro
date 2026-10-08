import { cardToolsBeforeOutcome } from "@agent/lib/delivery/browser-report";
import { actionsHeldForAnswer } from "@agent/lib/delivery/questions";
import type { TurnKind } from "./kind";
import {
  backgroundTaskTurnTools,
  reportTurnTools,
  taskAgentTool,
} from "./sets";

/** The tools a step may call, as its model selection takes them. */
export interface StepToolSet {
  /** The only tools the step may call, when not every tool of the turn. */
  readonly offeredTools?: readonly string[];
  /** Tools the step may not call, though the turn has them. */
  readonly withheldTools: readonly string[];
}

/**
 * Which tools one step may call, as `withheldTools` and `offeredTools` of
 * its model selection (`agent/lib/model/selection.ts`).
 *
 * Outside the pilot of the cache-friendly step this is the rule as it was:
 * a step loses `ask_question` in a report or after the turn's question, a
 * browser report's messages once it is past its answer, the actions a
 * question to the person holds, and the card tools before a browser
 * report's message.
 *
 * In the pilot (`stableContext`) a turn is offered one set for all its
 * steps: a tool that comes and goes between steps changes the tool block,
 * which comes before the history, so the next step re-reads the whole
 * history at full price. What the old rule took away now refuses when
 * called: the card tools before the report's message (`reportCardHold`),
 * the report's messages past its answer (`agent/tools/messaging.ts`). Two
 * removals stay: `ask_question`, which eve turns into a question card by its
 * name whatever answers the call (`harness/input-extraction.js`), and the
 * actions held for an answer, until the durable turn state they would be
 * masked by is checked in `eve dev` (docs/roadmap.md, 25). `task` belongs
 * to the turn as the task agent's pilot does.
 */
export function turnTools(step: {
  readonly browserFiles?: boolean;
  /** The turn already put an `ask_question` to the person. */
  readonly askedQuestion: boolean;
  /** A browser report's turn before its message (`cardToolsBeforeOutcome`). */
  readonly cardsHeld: boolean;
  /** The turn's question holds the actions it asked about. */
  readonly heldForAnswer: boolean;
  readonly kind: TurnKind;
  /** A browser report's turn whose send was dropped as past its answer. */
  readonly reportPastAnswer: boolean;
  /** The pilot of the cache-friendly step (`stepContextPilot`). */
  readonly stableContext: boolean;
  /** The task agent's pilot (`taskAgentPilot`). */
  readonly taskAgent: boolean;
}): StepToolSet {
  const reportTurn =
    step.kind === "browser-report" ||
    step.kind === "scheduled-report" ||
    step.kind === "phone-report";
  const askQuestion = reportTurn || step.askedQuestion ? ["ask_question"] : [];
  const held = step.heldForAnswer ? actionsHeldForAnswer : [];
  const task = step.taskAgent ? [] : [taskAgentTool];
  const offeredTools =
    step.kind === "phone-report"
      ? ["send_message", "react_to_message", "phone-status", "calculate"]
      : step.kind === "background-task"
        ? step.browserFiles
          ? ["browser_files", ...backgroundTaskTurnTools]
          : backgroundTaskTurnTools
        : step.stableContext && step.kind === "browser-report"
          ? step.browserFiles
            ? [
                "browser_files",
                ...(step.taskAgent ? [taskAgentTool] : []),
                ...reportTurnTools,
              ]
            : reportTurnTools
          : undefined;
  const withheldTools = step.stableContext
    ? [...askQuestion, ...held, ...task]
    : [
        ...askQuestion,
        ...(step.reportPastAnswer ? ["react_to_message", "send_message"] : []),
        ...held,
        ...(step.cardsHeld ? cardToolsBeforeOutcome : []),
        ...task,
      ];
  // A step that keeps every tool has no `offeredTools` at all.
  return offeredTools ? { offeredTools, withheldTools } : { withheldTools };
}
