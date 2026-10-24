import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { cardPressOf } from "@agent/lib/cards/caller";
import { openCardReport } from "@agent/lib/cards/report";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { cardsEnabled } from "@shared/cards/pilot";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  browserAnswer,
  leavesRunAtWork,
} from "@agent/lib/delivery/browser-report";
import { finishCardResponse, linkCardResponseRun } from "@db/services/cards";

const activePress = defineState<{
  readonly id: string;
  readonly turnId: string;
} | null>("bro.card-turn", () => null);

/**
 * The press on a card's page whose turn this is (`agent/lib/cards/answers.ts`).
 * A subagent inherits its parent's caller, so only the conversation's own
 * turn answers for it.
 */
function pressOf(ctx: HookContext) {
  const caller = ctx.session.auth.current;
  if (
    ctx.session.parent ||
    caller?.principalType !== "user" ||
    !cardsEnabled(scopeFromPrincipal(caller))
  )
    return undefined;
  const active = activePress.get();
  return active?.turnId === ctx.session.turn.id ? active.id : undefined;
}

/**
 * Records how the turn a card's press became goes (`docs/cards-apps.md`,
 * 3.2): its end lets the card's next press go and tells the open page Bro is
 * done, and a browser run it started keeps the page showing the search until
 * the run reports. A failed write is only logged: the card's page then waits
 * out the open turn's lease instead.
 */
async function record(press: string, write: () => Promise<void>) {
  try {
    await write();
  } catch (error) {
    console.warn("[cards] the press's turn was not recorded", {
      name: error instanceof Error ? error.name : "unknown",
      press,
    });
  }
}

async function finish(ctx: HookContext) {
  const press = pressOf(ctx);
  if (press) await record(press, () => finishCardResponse(press, new Date()));
  activePress.update(() => null);
}

export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      const caller = ctx.session.auth.current;
      if (
        ctx.session.parent ||
        caller?.principalType !== "user" ||
        !cardsEnabled(scopeFromPrincipal(caller))
      )
        return;
      const id = cardPressOf(caller);
      activePress.update(() =>
        id ? { id, turnId: ctx.session.turn.id } : null
      );
      const runId = reportedBrowserRunId(caller);
      await record(id ?? runId ?? "none", () => openCardReport(runId));
    },
    async "action.result"(event, ctx) {
      const press = pressOf(ctx);
      const { result, status } = event.data;
      if (
        !press ||
        status !== "completed" ||
        result.kind !== "tool-result" ||
        result.toolName !== "browser_task" ||
        result.isError === true
      ) {
        return;
      }
      const output = { type: "json" as const, value: result.output };
      const runId = browserAnswer(output)?.runId;
      if (runId === undefined || !leavesRunAtWork(output)) return;
      await record(press, () => linkCardResponseRun(press, runId));
    },
    "turn.completed": async (_event, ctx) => {
      await finish(ctx);
    },
    "turn.cancelled": async (_event, ctx) => {
      await finish(ctx);
    },
    "turn.failed": async (_event, ctx) => {
      await finish(ctx);
    },
  },
});
