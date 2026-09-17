import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  isTelegramReaction,
  setTelegramReaction,
  TELEGRAM_REACTIONS,
} from "../lib/telegram";
import { attr } from "../lib/turn-attrs";

const NAMES = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
  "eyes",
] as const;

export default defineTool({
  description:
    "Telegram reaction (love/like/dislike/laugh/emphasize/question/eyes) on the latest inbound. Then reply [SILENT]. Use for «ок», «спасибо», «понял» — do not overuse.",
  inputSchema: z.object({
    reaction: z.enum(NAMES),
  }),
  async execute({ reaction }, ctx) {
    if (!isTelegramReaction(reaction)) return { error: "unsupported reaction" };
    const chatId = attr(ctx, "telegramChatId");
    const messageId = attr(ctx, "messageId");
    if (!chatId || !messageId) {
      return { error: "нет Telegram-сообщения для реакции" };
    }
    const id = Number(messageId);
    if (!Number.isFinite(id)) return { error: "нет Telegram-сообщения для реакции" };
    try {
      await setTelegramReaction({
        chatId,
        messageId: id,
        emoji: TELEGRAM_REACTIONS[reaction],
      });
    } catch (err) {
      console.error("telegram react", err);
      return { error: "не получилось поставить реакцию — сообщение могло быть удалено" };
    }
    return { reaction, emoji: TELEGRAM_REACTIONS[reaction], targetMessageId: messageId };
  },
});
