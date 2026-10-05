import { z } from "zod";
import {
  alertOwner,
  clearOwnerAlert,
  ownerAlertTarget,
} from "@agent/lib/owner-alert";
import { env } from "@shared/environment";
import { directModelProvider } from "@shared/model/provider";
import { modelEndpoint } from "./endpoint";

const requestTimeoutMs = 10_000;
/** A low balance is repeated at most once a day unless it keeps falling. */
const alertRepeatAfterMs = 24 * 60 * 60_000;

/** What is left on OpenRouter, in dollars: credit bought less credit used. */
const openRouterBalanceSchema = z
  .object({
    data: z.object({
      total_credits: z.number(),
      total_usage: z.number(),
    }),
  })
  .transform(({ data }) => data.total_credits - data.total_usage);

/** RouterAI reports only what is left, already in roubles (probe of 01.10). */
const routerAiBalanceSchema = z
  .object({ data: z.object({ credits: z.number() }) })
  .transform(({ data }) => data.credits);

/**
 * The balance of the backend that serves Bro's model, or nothing when the
 * deployment has not asked for a check. On RouterAI the ordinary key reads
 * `/credits`; OpenRouter's credits endpoint takes only a management key, so
 * its check runs only with OPENROUTER_MANAGEMENT_KEY. The two keep separate
 * alert state: a balance in roubles is never compared with one in dollars.
 */
function balanceSource() {
  if (directModelProvider() === "routerai") {
    const endpoint = modelEndpoint();
    if (endpoint === undefined) return undefined;
    return {
      alertKey: "routerai-low-credits",
      apiKey: endpoint.apiKey,
      creditsUrl: `${endpoint.baseURL}/credits`,
      format: (amount: number) => `${amount.toFixed(2)} ₽`,
      minimumDrop: 50,
      name: endpoint.name,
      remaining: routerAiBalanceSchema,
      threshold: env.ROUTERAI_CREDITS_ALERT_RUB,
      topUpUrl: "routerai.ru/settings/billing",
    };
  }
  const managementKey = env.OPENROUTER_MANAGEMENT_KEY;
  if (!managementKey) return undefined;
  return {
    alertKey: "openrouter-low-credits",
    apiKey: managementKey,
    creditsUrl: "https://openrouter.ai/api/v1/credits",
    format: (amount: number) => `$${amount.toFixed(2)}`,
    minimumDrop: 1,
    name: "OpenRouter",
    remaining: openRouterBalanceSchema,
    threshold: env.OPENROUTER_CREDITS_ALERT_USD,
    topUpUrl: "openrouter.ai/settings/credits",
  };
}

type BalanceSource = NonNullable<ReturnType<typeof balanceSource>>;

/**
 * The balance is read every ten minutes. What was already said lives in the
 * database, so a skipped tick only delays the check and a repeated one cannot
 * alert twice.
 */
export function creditCheckDue(now: Date) {
  return now.getUTCMinutes() % 10 === 0;
}

/**
 * Reads the model backend's balance and tells the owner in Telegram when it
 * falls below the threshold. The alert repeats once a day while the balance
 * stays low, sooner when it keeps halving, and is re-armed once it recovers.
 * An alert without the owner's chat has nowhere to go, so none is read then.
 */
export async function checkModelCredits(now = new Date()) {
  if (!ownerAlertTarget()) return;
  const source = balanceSource();
  if (!source) return;
  try {
    const remaining = await readRemainingCredits(source);
    if (remaining >= source.threshold) {
      await clearOwnerAlert(source.alertKey, now);
      return;
    }
    await alertOwner(source.alertKey, creditAlertText(remaining, source), {
      minimumDrop: source.minimumDrop,
      now,
      repeatAfterMs: alertRepeatAfterMs,
      value: remaining,
    });
  } catch (error) {
    console.warn("[model] credit balance check failed", {
      backend: source.name,
      cause: error,
    });
  }
}

async function readRemainingCredits(source: BalanceSource) {
  const response = await fetch(source.creditsUrl, {
    headers: { Authorization: `Bearer ${source.apiKey}` },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `${source.name} credits request failed (${String(response.status)}).`
    );
  }
  return source.remaining.parse(await response.json());
}

function creditAlertText(remaining: number, source: BalanceSource) {
  return [
    `На ${source.name} осталось ${source.format(remaining)} (порог ${source.format(source.threshold)}).`,
    `Когда кредиты кончатся, Бро перестанет отвечать всем: пополни баланс на ${source.topUpUrl}.`,
  ].join("\n");
}
