import { defineHook } from "eve/hooks";
import {
  appendConversationLine,
  conversationLineLimit,
} from "@db/services/conversation-log";
import { crossChannelPilot } from "@agent/lib/conversation/pilot";
import { withoutSecrets } from "@agent/lib/privacy/secrets";
import { recapChannels } from "@agent/lib/conversation/recap";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { isBackgroundTurnText } from "@shared/chat/background-turn";

/**
 * What the person says in a turn they started, a line per message, into
 * `conversation_log` for the recap another channel shows
 * (`agent/lib/conversation/recap.ts`). Only for the pilot
 * (CROSS_CHANNEL_WORKSPACES), only the web chat, Telegram and iMessage. A
 * turn Bro opened for itself — a browser run's report, a schedule's worker
 * or report — speaks for nobody and is not logged, nor is a task's report,
 * which eve brings in under the person's caller
 * (`execution.background_task`). What Bro said is not logged: its messages
 * quote mail, pages and task output, and the recap reaches another chat as
 * user-role turn context. One-time codes, card numbers and passwords are
 * cut out first (`withoutSecrets`): the log is a store of its own, and a
 * recap would carry an SMS code to another chat. A failed write costs the
 * line, never the turn.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      if (event.data.kind !== undefined) return;
      const text = event.data.message;
      if (isBackgroundTurnText(text)) return;
      // A subagent inherits its parent's caller but is not where anyone talks.
      if (ctx.session.parent) return;
      const channel = ctx.channel.kind;
      if (channel === undefined || !recapChannels.has(channel)) return;
      if (!startedByPerson(ctx)) return;
      const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
      if (!caller) return;
      try {
        const scope = scopeFromPrincipal(caller);
        if (!(await crossChannelPilot(scope))) return;
        await appendConversationLine(scope.workspaceId, {
          channel,
          createdAt: new Date(event.meta.at),
          sessionId: ctx.session.id,
          text: withoutSecrets(text, conversationLineLimit),
          turnId: event.data.turnId,
        });
      } catch (error) {
        // The error of a failed insert quotes its parameters, the line among
        // them: only its name is logged.
        console.warn("[cross-channel] a conversation line was not logged", {
          cause: error instanceof Error ? error.name : "unknown",
          sessionId: ctx.session.id,
        });
      }
    },
  },
});
