import { defineAgent, defineDynamic } from "eve";
import { scheduledRunIdentity } from "@agent/lib/schedules/identity";
import { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import { getFormOfAddress, getWorkspaceModelId } from "@db/services/settings";
import {
  personLanguage,
  replyDirective,
  wordlessLatestMessage,
} from "@agent/lib/delivery/language";
import {
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
  cardToolsBeforeOutcomeNote,
  cardToolsRefuseBeforeOutcomeNote,
  owedStepsNote,
} from "@agent/lib/delivery/browser-report";
import {
  declinedErrandNote,
  turnDeclinedErrand,
} from "@agent/lib/delivery/declined-cards";
import { browserRunReportDelivered } from "@db/services/browser-runs";
import {
  approvedResendOwed,
  turnMustEnd,
  turnSends,
} from "@agent/lib/delivery/turn-sends";
import {
  declinedGmailSendNote,
  readsMustEnd,
  turnDeclinedGmailSend,
} from "@agent/lib/google-workspace/turn-reads";
import { clockModes, localClock } from "@agent/lib/local-time";
import { resolveModeValue } from "@agent/lib/mode";
import { modelSelection } from "@agent/lib/model/selection";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { stepContextPilot } from "@agent/lib/step-context/pilot";
import { skillSetup, skillsLayout, skillsPilot } from "@agent/lib/skills/pilot";
import { offeredSkills } from "@agent/lib/skills/tools";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { taskAgentPilot } from "@agent/lib/sandbox/pilot";
import { turnKind } from "@agent/lib/turn-kind/kind";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import { turnTools } from "@agent/lib/turn-kind/tools";
import { directModelActive } from "@shared/model/provider";
import { env } from "@shared/environment";

/**
 * What a report turn is told when its report already reached the person in
 * an earlier turn.
 */
const staleReportNote =
  "This browser report already reached the person in an earlier turn. Do not tell them again and do not act on it: end this turn now, without a word.";

export default defineAgent({
  defaultTools: false,
  // Off Vercel, turn state lives in Postgres: the Cloud.ru VM's build sets
  // WORKFLOW_WORLD=postgres (scripts/cloudru-app-host). Unset, eve keeps
  // Vercel Workflow, as every Vercel build does.
  experimental:
    env.WORKFLOW_WORLD === "postgres"
      ? { workflow: { world: "@workflow/world-postgres" } }
      : undefined,
  model: defineDynamic({
    events: {
      "step.started": async (event, ctx) => {
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
        // eve delivers the task agent's report in a turn of its own that
        // keeps the previous turn's caller: after a browser report it would
        // pass for that report again, and be dropped as stale.
        const kind = turnKind(ctx);
        const backgroundTaskTurn = kind === "background-task";
        // Such a turn is held to a few tools (below), and only the direct
        // model (RouterAI or OpenRouter) holds a step to them: a Gateway id would offer
        // every tool, those that act in the person's name too, to text the
        // task agent brought from the web. It fails instead.
        if (backgroundTaskTurn && !directModelActive()) {
          throw new Error(
            "A background task's report needs the direct model (RouterAI or OpenRouter), which alone limits its tools."
          );
        }
        const reportRunId =
          kind === "browser-report"
            ? reportedBrowserRunId(ctx.session.auth.current)
            : undefined;
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
          kind === "browser-report" || kind === "scheduled-report";
        // A forced step whose send failed would be forced into the same
        // failed call again: from then on the model writes the reply itself.
        const sendFailed =
          sends.delivered.length === 0 && turnSendFailed(ctx.messages);
        // A claim about a call the person just approved went back to be
        // checked against its result: the message is owed once more, even
        // in a turn that already delivered one before the card, where the
        // step would otherwise go unforced and could end without it.
        const resendOwed = approvedResendOwed(ctx.messages);
        const requireToolCall =
          !staleReport &&
          !sendFailed &&
          (resendOwed ||
            (resolveModeValue(ctx, {
              interactive:
                reportRunId === undefined
                  ? awaitsDelivery(ctx.messages)
                  : reportFirstStep,
            }) ??
              false));
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
        // The pilot of the cache-friendly step (docs/agent-costs.md, 3.2):
        // the person's clock comes with this step's notes after the history
        // instead of in the turn's instructions (`50-local-time.ts`). Its
        // lookups run alongside the step's other reads.
        const clockOwed =
          caller.principalType === "user" &&
          resolveModeValue(ctx, clockModes) !== null;
        // The pilots' verdicts hold for the whole turn: one that flipped
        // between steps changed the step's notes and tools.
        const step = stepIdentity(
          stepStartedEventSchema.safeParse(event).data,
          ctx.session.id
        );
        const [modelId, formOfAddress, [stableContext, timeZone], taskAgent] =
          await Promise.all([
            getWorkspaceModelId(scope),
            writesToPerson ? getFormOfAddress(scope) : undefined,
            stepContextPilot(scope, step).then(
              async (pilot) =>
                [
                  pilot,
                  pilot && clockOwed
                    ? await readWorkspaceTimeZone(scope)
                    : undefined,
                ] as const
            ),
            // The task agent works for the person's own requests; a report
            // or a worker never starts one.
            resolveModeValue(ctx, { interactive: true }) === true && !reportTurn
              ? taskAgentPilot(scope, step)
              : false,
          ]);
        const heldForAnswer = turnAwaitsAnswer(ctx.messages);
        const notes = [
          timeZone === undefined ? undefined : localClock(new Date(), timeZone),
          formOfAddress
            ? replyDirective({
                // Once the reply is out, the note must not read as a new
                // request: answering it is how one turn sent six messages.
                answered: sends.delivered.length > 0,
                formOfAddress,
                language: replyLanguage,
                // Nor while the message about an approved call is owed.
                stepOwed: owedSteps.length > 0 || resendOwed,
                wordlessLatest: wordlessLatestMessage(ctx.messages),
              })
            : undefined,
          staleReport ? staleReportNote : undefined,
          cardsHeld && !silent
            ? stableContext
              ? cardToolsRefuseBeforeOutcomeNote
              : cardToolsBeforeOutcomeNote
            : undefined,
          // A tool that vanished without a word is one the model says it
          // used anyway.
          heldForAnswer ? heldForAnswerNote : undefined,
          // eve answers a declined card with «Tool execution was denied»,
          // which the reply retold as a failure.
          writesToPerson && turnDeclinedErrand(ctx.messages)
            ? declinedErrandNote
            : undefined,
          // In the pilot `gmail-draft` keeps its description after the card.
          stableContext && turnDeclinedGmailSend(ctx.messages)
            ? declinedGmailSendNote
            : undefined,
          owedSteps.length > 0
            ? owedStepsNote(owedSteps, stableContext)
            : undefined,
          writesToPerson && sendFailed ? failedSendNote : undefined,
        ].filter((note) => note !== undefined);
        const selection: Parameters<typeof modelSelection>[1] = {
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
          // The skills pilot reads Bro's rules from `bro-skill` blocks in the
          // conversation; a forged one is defused (docs/roadmap.md, 24).
          skillBlocks: skillsPilot(ctx) ? true : undefined,
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
          // In the skills pilot a person's step has a domain's tools once
          // the conversation has its rules (`offeredSkills`).
          toolGroups:
            kind === "person" && skillsLayout(ctx) === "core"
              ? offeredSkills(ctx.messages, skillSetup(ctx))
              : undefined,
          // In the pilot a turn keeps one tool set from its first step to
          // its last (`turnTools`).
          ...turnTools({
            askedQuestion: turnAskedQuestion(ctx.messages),
            cardsHeld,
            heldForAnswer,
            kind,
            reportPastAnswer,
            stableContext,
            taskAgent,
          }),
        };
        // A turn that delivers the task agent's report is held to its few
        // tools in every layout (`backgroundTaskTurnTools`).
        if (!stableContext && !backgroundTaskTurn) {
          return modelSelection(modelId, selection);
        }
        return modelSelection(modelId, { ...selection, stableContext, step });
      },
    },
  }),
  reasoning: "low",
  compaction: {
    thresholdPercent: 0.7,
  },
});
