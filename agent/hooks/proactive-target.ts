import { defineHook, type HookContext } from "eve/hooks";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { recordProactiveTarget } from "@db/services/proactive";

// A messaging chat is addressed by the id its channel stamps on the caller.
const messagingConversationSchema = z.object({
  conversationChannel: z.enum(["photon", "telegram"]),
  conversationId: z.string().min(1),
});
const webConversationSchema = z.object({
  conversationChannel: z.literal("eve"),
});

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      if (resolveModeValue(ctx, { interactive: true }) !== true) return;
      const caller = ctx.session.auth.current;
      // A finished browser errand wakes the conversation it started in, which
      // is not necessarily where the person talks now.
      if (
        caller?.principalType !== "user" ||
        caller.authenticator === "browser-result"
      ) {
        return;
      }
      const conversation = proactiveConversation(ctx.session);
      if (!conversation) return;
      try {
        await recordProactiveTarget(scopeFromPrincipal(caller), conversation);
      } catch (error) {
        // Proactive messages are a nicety; the person's own turn goes on.
        console.warn("[proactive] could not record the conversation", {
          cause: error,
          sessionId: ctx.session.id,
        });
      }
    },
  },
});

/**
 * Where the person talks now. The web chat has no address but its session: a
 * report reaches it through a handle on that exact session, and the message
 * waits in the chat for the next time the person opens it. A subagent's own
 * session is never one the person reads.
 */
function proactiveConversation(session: HookContext["session"]) {
  const attributes = session.auth.current?.attributes;
  const messaging = messagingConversationSchema.safeParse(attributes);
  if (messaging.success) return messaging.data;
  if (session.parent) return undefined;
  return webConversationSchema.safeParse(attributes).success
    ? { conversationChannel: "eve" as const, conversationId: session.id }
    : undefined;
}
