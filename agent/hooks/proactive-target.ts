import { defineHook } from "eve/hooks";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { recordProactiveTarget } from "@db/services/proactive";

// Only conversations Bro can push into count; the web chat has no one
// listening once the tab closes.
const conversationSchema = z.object({
  conversationChannel: z.enum(["photon", "telegram"]),
  conversationId: z.string().min(1),
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
      const conversation = conversationSchema.safeParse(caller.attributes);
      if (!conversation.success) return;
      try {
        await recordProactiveTarget(
          scopeFromPrincipal(caller),
          conversation.data
        );
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
