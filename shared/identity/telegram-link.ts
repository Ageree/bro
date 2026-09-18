import { env } from "@shared/environment";

/**
 * Resolves the deep link a person opens to bind their Telegram account. The
 * bot username is read on first use so a deployment without Telegram still
 * boots, and every caller renders the same `?start=link_<token>` payload the
 * channel redeems.
 */
export function telegramLinkUrl(token: string) {
  const botUsername = env.TELEGRAM_BOT_USERNAME;
  if (!botUsername) {
    throw new Error(
      "Telegram is not configured for this deployment. Set TELEGRAM_BOT_USERNAME."
    );
  }
  return `https://t.me/${botUsername}?start=link_${token}`;
}

export function telegramLinkConfigured() {
  return env.TELEGRAM_BOT_USERNAME !== undefined;
}
