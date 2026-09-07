import { defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import {
  isTelegramReaction,
  setTelegramReaction,
  TELEGRAM_REACTIONS,
} from "../lib/telegram";

function attrs(ctx: ToolContext): Record<string, unknown> | undefined {
  return (
    ctx.session.auth.current?.attributes ??
    ctx.session.auth.initiator?.attributes
  );
}

function attr(ctx: ToolContext, key: string): string | undefined {
  const raw = attrs(ctx)?.[key];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id === "string" && id.length > 0) return id;
  return undefined;
}

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
    await setTelegramReaction({
      chatId,
      messageId: id,
      emoji: TELEGRAM_REACTIONS[reaction],
    });
    return { reaction, emoji: TELEGRAM_REACTIONS[reaction], targetMessageId: messageId };
  },
});
