import type { SessionContext } from "eve/context";
import { z } from "zod";
import { telegramConversationIdSchema } from "@agent/lib/telegram-conversation";
import { agencyWorkerTurn } from "./policy";

export function phoneReportRoute(context: Pick<SessionContext, "session">) {
  if (context.session.parent)
    throw new Error("A delegated session cannot bind a phone report route.");
  const caller = context.session.auth.current;
  const conversationChannel = z
    .enum(["eve", "photon", "telegram"])
    .parse(caller?.attributes.conversationChannel);
  // The agentic worker's own session is not the person's chat: its report
  // goes to the chat its job writes to, as the worker's own caller names it.
  const conversationId =
    conversationChannel === "eve"
      ? agencyWorkerTurn(context)
        ? z.string().min(1).parse(caller?.attributes.conversationId)
        : context.session.id
      : conversationChannel === "photon"
        ? z
            .string()
            .startsWith("imessage:")
            .parse(caller?.attributes.conversationId)
        : telegramConversationIdSchema.parse(caller?.attributes.conversationId);
  return { sessionId: context.session.id, conversationChannel, conversationId };
}
