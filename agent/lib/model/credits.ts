import { z } from "zod";
import { env } from "@shared/environment";

const creditsUrl = "https://openrouter.ai/api/v1/credits";
const telegramApiBaseUrl = "https://api.telegram.org";
const requestTimeoutMs = 10_000;

const creditsResponseSchema = z.object({
  data: z.object({
    total_credits: z.number(),
    total_usage: z.number(),
  }),
});

/**
 * Everything the balance check needs, or nothing when the deployment has not
 * asked for it. The credits endpoint takes only a management key, and an
 * alert without the owner's chat has nowhere to go.
 */
function creditCheckSettings() {
  const managementKey = env.OPENROUTER_MANAGEMENT_KEY;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const ownerChatId = env.OWNER_TELEGRAM_CHAT_ID;
  if (!managementKey || !botToken || !ownerChatId) return undefined;
  return {
    botToken,
    managementKey,
    ownerChatId,
    thresholdUsd: env.OPENROUTER_CREDITS_ALERT_USD,
  };
}

/**
 * The balance is read on the first minute of every hour, which keeps the
 * check to 24 cheap requests a day on a schedule that ticks every minute.
 */
export function creditCheckDue(now: Date) {
  return now.getUTCMinutes() === 0;
}

/**
 * Reads the OpenRouter balance and tells the owner in Telegram when it is
 * below the threshold. Nothing is remembered between checks, so a low balance
 * is repeated once an hour until someone tops it up: when credits run out,
 * every person's turn fails, so a reminder is worth more than a quiet chat.
 */
export async function checkOpenRouterCredits() {
  const settings = creditCheckSettings();
  if (!settings) return;
  try {
    const remainingUsd = await readRemainingCredits(settings.managementKey);
    if (remainingUsd >= settings.thresholdUsd) return;
    await notifyOwner(settings, creditAlertText(remainingUsd, settings));
  } catch (error) {
    console.warn("[openrouter] credit balance check failed", { cause: error });
  }
}

async function readRemainingCredits(managementKey: string) {
  const response = await fetch(creditsUrl, {
    headers: { Authorization: `Bearer ${managementKey}` },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `OpenRouter credits request failed (${String(response.status)}).`
    );
  }
  const { data } = creditsResponseSchema.parse(await response.json());
  return data.total_credits - data.total_usage;
}

function creditAlertText(
  remainingUsd: number,
  { thresholdUsd }: { readonly thresholdUsd: number }
) {
  return [
    `На OpenRouter осталось $${remainingUsd.toFixed(2)} (порог $${thresholdUsd.toFixed(2)}).`,
    "Когда кредиты кончатся, Бро перестанет отвечать всем: пополни баланс на openrouter.ai/settings/credits.",
  ].join("\n");
}

async function notifyOwner(
  {
    botToken,
    ownerChatId,
  }: { readonly botToken: string; readonly ownerChatId: string },
  text: string
) {
  const response = await fetch(
    `${telegramApiBaseUrl}/bot${botToken}/sendMessage`,
    {
      body: JSON.stringify({ chat_id: ownerChatId, text }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Telegram owner alert failed (${String(response.status)}).`
    );
  }
}
