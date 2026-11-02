import { env } from "@shared/environment";
import { compatibleBackend } from "./compatible";

/**
 * OrcaRouter, ahead of every other backend. Measured 02.11 on a step of 47k
 * tokens: 99.98% of the input from the prompt cache from the second call on
 * (it pins a session by its prefix), 1.4–2.3 s a step (RouterAI 3.4–7 s),
 * `tool_choice` obeyed in 12 of 12 calls, 80 calls in 10 s without a 429.
 * Its list price is $0.15 / $0.003 / $0.60 per million tokens for the same
 * `deepseek-v4.1-flash-1017` Bro runs on, so a cached step costs about
 * $0.00016 (≈0.013 ₽) against ≈0.04 ₽ at RouterAI.
 */
export const withOrcaRouterFirst = compatibleBackend({
  baseUrl: () => env.ORCAROUTER_BASE_URL,
  forcesTools: true,
  key: () => env.ORCAROUTER_API_KEY,
  models: new Map([
    ["deepseek/deepseek-v4.1-flash", env.ORCAROUTER_DEEPSEEK_FLASH_MODEL],
  ]),
  name: "OrcaRouter",
  rates: { cached: 0.003, input: 0.15, output: 0.6 },
  workspaces: () => env.ORCAROUTER_WORKSPACES,
  tag: "orcarouter",
});
