import { defineDynamic, defineInstructions } from "eve/instructions";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { hasOtherConversations } from "@db/services/chats";

/**
 * A new session looks like a first meeting to the model, and without this a
 * fresh web chat of a long-standing account opened with «привет, я бро».
 * The `first-contact` marker comes only with the workspace's first message
 * ever, so the two never meet in one turn.
 */
const acquaintanceInstructions =
  "Вы с этим человеком уже знакомы по другим разговорам. Новый чат — не новое знакомство: не представляйся и не перечисляй, что умеешь, пока он сам не спросит.";

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (
        caller?.principalType !== "user" ||
        !z.string().safeParse(caller.attributes.workspaceId).success ||
        resolveModeValue(context, { interactive: true }) !== true
      ) {
        return null;
      }
      const known = await hasOtherConversations(
        scopeFromPrincipal(caller),
        context.session.id
      );
      return known
        ? defineInstructions({ content: acquaintanceInstructions })
        : null;
    },
  },
});
