import { env } from "@shared/environment";

/**
 * The prices the cost accounting (`usage_costs`) converts consumption with.
 * The agent prices what it records with them, and the owner's summary adds
 * the fixed monthly part of a workspace VM from the same table. Cloud.ru
 * prices include VAT (tariff 7.EVO.1, `docs/browser-cloud-migration.md`).
 */

/**
 * A powered-on Cloud.ru VM, roubles an hour, by flavor: a workspace's VM and
 * the hosts of the browser pool (`docs/browser-pool.md`, section 3).
 */
const vmHourlyRub = new Map([
  ["gen-2-4", 2.97],
  ["gen-2-8", 5.5],
  ["gen-4-16", 7.98],
  ["gen-8-32", 15.96],
  ["gen-16-64", 31.92],
]);

/**
 * What a workspace VM bills whether it runs or not: its SSD boot disk and
 * its public address, roubles a month.
 */
export const vmFixedMonthlyRub = { disk: 114, publicIp: 149 } as const;

/**
 * RouterAI's price of the model the VM's browser agent runs on, roubles per
 * million tokens. The worker's own `total_cost` comes from browser-use's
 * dollar price list and misses models it does not know, so the tokens are
 * priced here instead. Measured from the `usage.cost` RouterAI returns with
 * each call (its `/models` list shows other numbers) at 08:40 MSK on
 * 01.10.2026; by 09:50 the same calls cost exactly twice as much, so a
 * worker's own bill (`billed`, agent/lib/costs/browser.ts) wins over these.
 * Before that the table had 9.66 / 1.21 / 48.28.
 */
const routerAiRubPerMillion = new Map([
  [
    "deepseek/deepseek-v4.1-flash",
    { cachedInput: 0.36, input: 17.92, output: 71.66 },
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
