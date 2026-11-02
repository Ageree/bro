import { env } from "@shared/environment";
import { compatibleBackend } from "./compatible";

/**
 * BeatAPI, for the price. Measured 02.11 on a step of 47k tokens: 99.5% of
 * the input is read from the prompt cache from the second call on, a step
 * takes 2.9–4.2 s (RouterAI 3.4–7 s, RunInfra ≈1.5 s). A cached step costs
 * about $0.00009 (≈0.007 ₽) against ≈0.04 ₽ at RouterAI and ≈0.11 ₽ at
 * RunInfra. Its account is limited to 10 requests a minute until topped up
 * further. Its `deepseek-v4.1-flash` ignores `tool_choice`
 * (`compatible.ts`, `forcesTools: false`).
 *
 * Its price is the `deepseek` group's: list ($0.15 / $0.60 / $0.003) times
 * the ratio 0.5, which a balance check on 02.11 confirmed.
 */
export const withBeatApiFirst = compatibleBackend({
  baseUrl: () => env.BEATAPI_BASE_URL,
  forcesTools: false,
  key: () => env.BEATAPI_API_KEY,
  models: new Map([
    ["deepseek/deepseek-v4.1-flash", env.BEATAPI_DEEPSEEK_FLASH_MODEL],
  ]),
  name: "BeatAPI",
  rates: { cached: 0.0015, input: 0.075, output: 0.3 },
  tag: "beatapi",
});
