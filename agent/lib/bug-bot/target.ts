import { env } from "@shared/environment";

/**
 * Where the bug bot reads and writes, or undefined while it is off. It needs
 * `BUG_BOT=on` and its own bot: the host's `stand` profile puts Bro's token
 * into OPS_ALERT_BOT_TOKEN, and polling `getUpdates` with it would take the
 * updates from `tg-bridge` (409 for both). So a token equal to
 * TELEGRAM_BOT_TOKEN, or no token at all, leaves the bot off.
 */
export function bugBotTarget() {
  if (env.BUG_BOT !== "on") return undefined;
  const botToken = env.OPS_ALERT_BOT_TOKEN;
  const ownerChatId = env.OPS_ALERT_CHAT_ID;
  if (!botToken || !ownerChatId) return undefined;
  if (botToken === env.TELEGRAM_BOT_TOKEN) return undefined;
  return { botToken, ownerChatId };
}
