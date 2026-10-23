import { z } from "zod";
import { telegramChatIdFromConversationId } from "@agent/lib/telegram-conversation";
import { env } from "@shared/environment";

const telegramReplySchema = z.object({ ok: z.boolean() });

/**
 * A card's message with the button that opens it in Telegram as a Mini App:
 * only Bro's code can send a `web_app` button, the model's messages carry no
 * buttons (as the YooMoney button, `agent/lib/yoomoney/onboarding.ts`).
 * Throws when it did not land.
 */
export async function sendCardButton(
  conversationId: string,
  url: string,
  message: string
) {
  const chatId = telegramChatIdFromConversationId(conversationId);
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !botToken) {
    throw new Error("Telegram is not set up for this conversation.");
  }
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      body: JSON.stringify({
        chat_id: chatId,
        reply_markup: {
          inline_keyboard: [[{ text: "Открыть карточку", web_app: { url } }]],
        },
        text: message,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    }
  );
  const accepted = telegramReplySchema.safeParse(
    await response.json().catch(() => undefined)
  ).data?.ok;
  if (!response.ok || accepted !== true) {
    throw new Error(`Telegram card failed (${String(response.status)}).`);
  }
}
