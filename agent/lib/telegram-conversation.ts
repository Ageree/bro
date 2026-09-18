import { z } from "zod";

/**
 * eve keys a Telegram session by a continuation token of
 * `<chatId>:<messageThreadId>:<conversationId>`; a private chat leaves the last
 * two segments empty. Schedules and reply targets persist that token, so this
 * is where the shape is parsed back into an addressable chat.
 */
const telegramConversationIdPattern = /^(?<chatId>-?\d{1,20}):\d*:\d*$/u;

export const telegramConversationIdSchema = z
  .string()
  .regex(telegramConversationIdPattern);

export function telegramChatIdFromConversationId(conversationId: string) {
  return telegramConversationIdPattern.exec(conversationId)?.groups?.chatId;
}
