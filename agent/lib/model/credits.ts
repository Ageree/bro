import { z } from "zod";
import { alertOwner, clearOwnerAlert } from "@agent/lib/owner-alert";
import { env } from "@shared/environment";

const creditsUrl = "https://openrouter.ai/api/v1/credits";
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
  if (
    !managementKey ||
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_OWNER_CHAT_ID
  ) {
    return undefined;
  }
  return { managementKey, thresholdUsd: env.OPENROUTER_CREDITS_ALERT_USD };
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
      await clearOwnerAlert(alertKey, now);
      return;
    }
    await alertOwner(alertKey, creditAlertText(remainingUsd, settings), {
      minimumDrop: alertMinimumDropUsd,
      now,
      repeatAfterMs: alertRepeatAfterMs,
      value: remainingUsd,
    });
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
