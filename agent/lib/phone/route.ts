import type { SessionContext } from "eve/context";
import { z } from "zod";
import { telegramConversationIdSchema } from "@agent/lib/telegram-conversation";

export function phoneReportRoute(context: Pick<SessionContext, "session">) {
  if (context.session.parent)
    throw new Error("A delegated session cannot bind a phone report route.");
  const caller = context.session.auth.current;
  const conversationChannel = z
    .enum(["eve", "photon", "telegram"])
    .parse(caller?.attributes.conversationChannel);
  const conversationId =
    conversationChannel === "eve"
      ? context.session.id
      : conversationChannel === "photon"
        ? z
            .string()
            .startsWith("imessage:")
            .parse(caller?.attributes.conversationId)
        : telegramConversationIdSchema.parse(caller?.attributes.conversationId);
  return { sessionId: context.session.id, conversationChannel, conversationId };
}
