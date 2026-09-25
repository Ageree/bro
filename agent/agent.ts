import { defineAgent, defineDynamic } from "eve";
import { scheduledRunIdentity } from "@agent/lib/schedules/identity";
import { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import { getFormOfAddress, getWorkspaceModelId } from "@db/services/settings";
import { personLanguage, replyDirective } from "@agent/lib/delivery/language";
import {
  actionsHeldForAnswer,
  heldForAnswerNote,
  turnAskedQuestion,
  turnAwaitsAnswer,
} from "@agent/lib/delivery/questions";
import {
  awaitsDelivery,
  failedSendNote,
  outcomeToldEarlier,
  reportOwedSteps,
  turnActed,
  turnDelivered,
  turnHandedErrandOn,
  turnSendFailed,
  turnTookNoStep,
} from "@agent/lib/delivery/pending";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import {
  cardToolsBeforeOutcome,
  cardToolsBeforeOutcomeNote,
  owedStepsNote,
} from "@agent/lib/delivery/browser-report";
import {
  declinedErrandNote,
  turnDeclinedErrand,
} from "@agent/lib/delivery/declined-cards";
import { browserRunReportDelivered } from "@db/services/browser-runs";
import { turnMustEnd, turnSends } from "@agent/lib/delivery/turn-sends";
import { readsMustEnd } from "@agent/lib/google-workspace/turn-reads";
import { resolveModeValue } from "@agent/lib/mode";
import { modelSelection } from "@agent/lib/model/selection";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

/**
 * What a report turn is told when its report already reached the person in
 * an earlier turn.
 */
const staleReportNote =
  "This browser report already reached the person in an earlier turn. Do not tell them again and do not act on it: end this turn now, without a word.";

export default defineAgent({
  defaultTools: false,
  model: defineDynamic({
    events: {
      "step.started": async (_event, ctx) => {
        const scheduledRun = scheduledRunIdentity(ctx.session.auth);
        if (
          scheduledRun &&
          !(await isScheduledAgentRunLeaseActive(
            scheduledRun.runId,
            scheduledRun.leaseToken
          ))
        ) {
          throw new Error("The scheduled run lease is no longer active.");
        }
        const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (!caller) throw new Error("An authenticated user is required.");
        // A person's message is answered only through send_message or
        // react_to_message; plain assistant text is internal. Until one of
        // them goes through, an interactive step may not end in text. A
        // browser run's result arrives as a message too. Its first step must
        // call a tool: a model that answered a report with an empty step
        // (gpt-6-luna on 24.09) failed the turn before the person heard
        // anything. The steps after it stay free, so a report can still end
        // in a quiet `continue` on the errand
        // (`agent/lib/browser-use/completion.ts`).
        //
        // A turn whose send was dropped — a repeat, or a rephrased status
        // with nothing new — or that used up its message limit is past its
        // answer: its next step may only write text, which ends the turn
        // (`agent/lib/delivery/turn-sends.ts`). So is one that
        // keeps asking Google for reads the turn guard refuses
        // (`agent/lib/google-workspace/turn-reads.ts`). A browser report's
        // turn past its answer may still owe the errand a `continue` — the
        // one card for the option the run found — so it loses only its
        // messages, until it calls a tool after the dropped send.
        //
        // A report sent again after its lease — it waited behind a long turn
        // of the person's, or `browser_task status` handed it over — has
        // already reached them, and so has one whose outcome an earlier turn
        // took from `status` and told them. That turn says nothing and ends.
        const reportRunId = reportedBrowserRunId(ctx.session.auth.current);
        const reportFirstStep =
          reportRunId !== undefined && turnTookNoStep(ctx.messages);
        const staleReport =
          reportFirstStep &&
          (outcomeToldEarlier(ctx.messages, reportRunId) ||
            (await browserRunReportDelivered(reportRunId)));
        const pastAnswer = turnMustEnd(ctx.messages);
        const sends = turnSends(ctx.messages);
        const reportPastAnswer =
          pastAnswer && reportRunId !== undefined && !sends.workAfterSkip;
        // A report turn with nothing to say sent no message of its own, so
        // Telegram and iMessage would post whatever text it ends with; DeepSeek
        // writes a line («Отчёт уже доставлен») where gpt-6-luna stayed empty.
        // So does one that handed the errand on in a quiet `continue`.
        const silent =
          staleReport ||
          (reportRunId !== undefined &&
            !turnDelivered(ctx.messages) &&
            turnHandedErrandOn(ctx.messages));
        // A card in a browser report's turn comes after the outcome, never
        // before it: the calendar entry for a confirmed booking follows the
        // message that tells the booking.
        const cardsHeld =
          reportRunId !== undefined &&
          !staleReport &&
          sends.delivered.length === 0;
        // Once the message is out, the card step the report asks for is
        // still to come: nothing may tell the turn to end before it.
        const owedSteps =
          reportRunId !== undefined &&
          !staleReport &&
          sends.delivered.length > 0
            ? reportOwedSteps(ctx.messages)
            : [];
        // A report — a browser run's or a schedule's — is Bro's own turn.
        // Its question goes out as a message, so the person's reply starts a
        // turn of their own: only there does `schedules-answer` resume a
        // waiting run and `continue` act on a confirmed errand. Answered
        // through `ask_question`, it would stay inside the report's turn.
        const reportTurn =
          reportRunId !== undefined ||
          resolveModeValue(ctx, { "scheduled-report": true }) === true;
        // A forced step whose send failed would be forced into the same
        // failed call again: from then on the model writes the reply itself.
        const sendFailed =
          sends.delivered.length === 0 && turnSendFailed(ctx.messages);
        const requireToolCall =
          !staleReport &&
          !sendFailed &&
          (resolveModeValue(ctx, {
            interactive:
              reportRunId === undefined
                ? awaitsDelivery(ctx.messages)
                : reportFirstStep,
          }) ??
            false);
        // The reply follows the language of the person's latest message,
        // which the long Russian prompt otherwise outweighs, and so do Bro's
        // own gender and the form of address the person chose, which hold in
        // every chat and channel of the workspace. Only turns that write to
        // the person carry them. A scheduled report continues the person's
        // conversation, so it follows their language too; its own English
        // prompt opens with the background-turn marker and is skipped.
        const replyLanguage =
          resolveModeValue(ctx, {
            interactive: personLanguage(ctx.messages),
            "scheduled-report": personLanguage(ctx.messages),
          }) ?? undefined;
        const writesToPerson =
          resolveModeValue(ctx, {
            interactive: true,
            "scheduled-report": true,
          }) ?? false;
        const scope = scopeFromPrincipal(caller);
        const [modelId, formOfAddress] = await Promise.all([
          getWorkspaceModelId(scope),
          writesToPerson ? getFormOfAddress(scope) : undefined,
        ]);
        const heldForAnswer = turnAwaitsAnswer(ctx.messages);
        const notes = [
          formOfAddress
            ? replyDirective({
                // Once the reply is out, the note must not read as a new
                // request: answering it is how one turn sent six messages.
                answered: sends.delivered.length > 0,
                formOfAddress,
                language: replyLanguage,
                stepOwed: owedSteps.length > 0,
              })
            : undefined,
          staleReport ? staleReportNote : undefined,
          cardsHeld && !silent ? cardToolsBeforeOutcomeNote : undefined,
          // A tool that vanished without a word is one the model says it
          // used anyway.
          heldForAnswer ? heldForAnswerNote : undefined,
          // eve answers a declined card with «Tool execution was denied»,
          // which the reply retold as a failure.
          writesToPerson && turnDeclinedErrand(ctx.messages)
            ? declinedErrandNote
            : undefined,
          owedSteps.length > 0 ? owedStepsNote(owedSteps) : undefined,
          writesToPerson && sendFailed ? failedSendNote : undefined,
        ].filter((note) => note !== undefined);
        return modelSelection(modelId, {
          // After the reply, a step with nothing to add may come back empty
          // (gpt-6-luna did it almost every time); it ends the turn rather
          // than failing a turn the person already has the answer to. So
          // does a report turn after a quiet `continue`, and one whose
          // report the person already has.
          delivered:
            staleReport ||
            turnDelivered(ctx.messages) ||
            (reportRunId !== undefined && turnActed(ctx.messages)),
          replyNote: notes.length > 0 ? notes.join("\n\n") : undefined,
          silent,
          toolChoice:
            staleReport ||
            (pastAnswer && !reportPastAnswer) ||
            readsMustEnd(ctx.messages)
              ? "none"
              : requireToolCall
                ? "required"
                : "auto",
          // One question per request, then Bro acts on the answer: a second
          // `ask_question` in the same turn is how a helper becomes an
          // interrogation. Approval cards stay, each is its action's consent,
          // except before a browser report's message.
          // A question sent as a message is answered in the person's next
          // message, so until then nothing it asked about is undone.
          withheldTools: [
            ...(reportTurn || turnAskedQuestion(ctx.messages)
              ? ["ask_question"]
              : []),
            ...(reportPastAnswer ? ["react_to_message", "send_message"] : []),
            ...(heldForAnswer ? actionsHeldForAnswer : []),
            ...(cardsHeld ? cardToolsBeforeOutcome : []),
          ],
        });
      },
    },
  }),
  reasoning: "low",
  compaction: {
    thresholdPercent: 0.7,
  },
});
