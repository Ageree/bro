import { env } from "@shared/environment";

const defaultGatewayModel = "openai/gpt-5.6-sol-fast";

/**
 * OpenRouter replaces AI Gateway routing whenever its API key is configured.
 * The Gateway free tier refuses most models, so a deployment without paid
 * Vercel credits runs every turn through OpenRouter instead.
 */
export function openRouterActive() {
  return env.OPENROUTER_API_KEY !== undefined;
}

/** Model a workspace uses until someone selects one for it. */
export function defaultModelId() {
  return openRouterActive() ? env.OPENROUTER_MODEL : defaultGatewayModel;
}
