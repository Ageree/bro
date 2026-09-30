import { env } from "@shared/environment";

/**
 * The prices the cost accounting (`usage_costs`) converts consumption with.
 * The agent prices what it records with them, and the owner's summary adds
 * the fixed monthly part of a workspace VM from the same table. Cloud.ru
 * prices include VAT (tariff 7.EVO.1, `docs/browser-cloud-migration.md`).
 */

/** A powered-on Cloud.ru VM, roubles an hour, by flavor. */
const vmHourlyRub = new Map([["gen-2-4", 2.97]]);

/**
 * What a workspace VM bills whether it runs or not: its SSD boot disk and
 * its public address, roubles a month.
 */
export const vmFixedMonthlyRub = { disk: 114, publicIp: 149 } as const;

/**
 * RouterAI's price of the model the VM's browser agent runs on, roubles per
 * million tokens. The worker's own `total_cost` comes from browser-use's
 * dollar price list and misses models it does not know, so the tokens are
 * priced here instead.
 */
const routerAiRubPerMillion = new Map([
  [
    "deepseek/deepseek-v4.1-flash",
    { cachedInput: 1.21, input: 9.66, output: 48.28 },
  ],
]);

/** Six decimals, the scale `usage_costs.cost_rub` keeps. */
function rub(value: number) {
  return Math.round(value * 1e6) / 1e6;
}

export function usdToRub(usd: number) {
  return rub(usd * env.USAGE_USD_RUB);
}

/** Undefined for a flavor without a price. */
export function vmUptimeRub(flavor: string, seconds: number) {
  const hourly = vmHourlyRub.get(flavor);
  return hourly === undefined ? undefined : rub((hourly * seconds) / 3600);
}

export function proxyTrafficRub(bytes: number) {
  return rub((bytes / 1e9) * env.BROWSER_VM_PROXY_RUB_PER_GB);
}

/**
 * The price of a browser agent's tokens through RouterAI, or undefined for a
 * model without one. `inputTokens` counts the cached ones too, as OpenAI and
 * browser-use report them.
 */
export function routerAiTokensRub(
  model: string,
  tokens: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  }
) {
  const price = routerAiRubPerMillion.get(model);
  if (price === undefined) return undefined;
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  return rub(
    ((tokens.inputTokens - cached) * price.input +
      cached * price.cachedInput +
      tokens.outputTokens * price.output) /
      1e6
  );
}
