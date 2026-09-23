import { z } from "zod";
import {
  claimOperationalAlert,
  clearOperationalAlert,
} from "@db/services/operational-alerts";
import { env } from "@shared/environment";

const creditsUrl = "https://openrouter.ai/api/v1/credits";
const telegramApiBaseUrl = "https://api.telegram.org";
const requestTimeoutMs = 10_000;
const alertKey = "openrouter-low-credits";
/** A low balance is repeated at most once a day unless it keeps falling. */
const alertRepeatAfterMs = 24 * 60 * 60_000;
const alertMinimumDropUsd = 1;

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
  const ownerChatId = env.TELEGRAM_OWNER_CHAT_ID;
  if (!managementKey || !botToken || !ownerChatId) return undefined;
  return {
    botToken,
    managementKey,
    ownerChatId,
    thresholdUsd: env.OPENROUTER_CREDITS_ALERT_USD,
  };
}

/**
 * The balance is read every ten minutes. What was already said lives in the
 * database, so a skipped tick only delays the check and a repeated one cannot
 * alert twice.
 */
export function creditCheckDue(now: Date) {
  return now.getUTCMinutes() % 10 === 0;
}

/**
 * Reads the OpenRouter balance and tells the owner in Telegram when it falls
 * below the threshold. The alert repeats once a day while the balance stays
 * low, sooner when it keeps halving, and is re-armed once it recovers.
 */
export async function checkOpenRouterCredits(now = new Date()) {
  const settings = creditCheckSettings();
  if (!settings) return;
  try {
    const remainingUsd = await readRemainingCredits(settings.managementKey);
    if (remainingUsd >= settings.thresholdUsd) {
      await clearOperationalAlert(alertKey, now);
      return;
    }
    const claimed = await claimOperationalAlert(alertKey, remainingUsd, {
      minimumDrop: alertMinimumDropUsd,
      now,
      repeatAfterMs: alertRepeatAfterMs,
    });
    if (!claimed) return;
    try {
      await notifyOwner(settings, creditAlertText(remainingUsd, settings));
    } catch (error) {
      // An alert nobody received must not hold back the next one for a day.
      await clearOperationalAlert(alertKey, now);
      throw error;
    }
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
