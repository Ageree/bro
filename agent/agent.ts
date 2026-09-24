import { defineAgent, defineDynamic } from "eve";
import { scheduledRunIdentity } from "@agent/lib/schedules/identity";
import { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import { getFormOfAddress, getWorkspaceModelId } from "@db/services/settings";
import { personLanguage, replyDirective } from "@agent/lib/delivery/language";
import { turnAskedQuestion } from "@agent/lib/delivery/questions";
import { awaitsDelivery, turnDelivered } from "@agent/lib/delivery/pending";
import { turnMustEnd, turnSends } from "@agent/lib/delivery/turn-sends";
import { readsMustEnd } from "@agent/lib/google-workspace/turn-reads";
import { resolveModeValue } from "@agent/lib/mode";
import { modelSelection } from "@agent/lib/model/selection";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

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
        // browser run's result arrives as a message too, but the run parked
        // on an anti-bot check is continued without a word to the person
        // (`agent/lib/browser-use/completion.ts`), so that turn stays free.
        //
        // A turn whose send was dropped — a repeat, or a rephrased status
        // with nothing new — or that used up its message limit is past its
        // answer: its next step may only write text, which ends the turn
        // (`agent/lib/delivery/turn-sends.ts`). So is one that
        // keeps asking Google for reads the turn guard refuses
        // (`agent/lib/google-workspace/turn-reads.ts`).
        const requireToolCall =
          caller.authenticator !== "browser-result" &&
          (resolveModeValue(ctx, {
            interactive: awaitsDelivery(ctx.messages),
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
        return modelSelection(modelId, {
          // After the reply, a step with nothing to add may come back empty
          // (gpt-6-luna does it almost every time); it ends the turn rather
          // than failing a turn the person already has the answer to.
          delivered: turnDelivered(ctx.messages),
          replyNote: formOfAddress
            ? replyDirective({
                // Once the reply is out, the note must not read as a new
                // request: answering it is how one turn sent six messages.
                answered: turnSends(ctx.messages).delivered.length > 0,
                formOfAddress,
                language: replyLanguage,
              })
            : undefined,
          toolChoice:
            turnMustEnd(ctx.messages) || readsMustEnd(ctx.messages)
              ? "none"
              : requireToolCall
                ? "required"
                : "auto",
          // One question per request, then Bro acts on the answer: a second
          // `ask_question` in the same turn is how a helper becomes an
          // interrogation. Approval cards stay, each is its action's consent.
          withheldTools: turnAskedQuestion(ctx.messages)
            ? ["ask_question"]
            : [],
        });
      },
    },
  }),
  reasoning: "low",
  compaction: {
    thresholdPercent: 0.7,
  },
});
