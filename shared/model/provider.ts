import { env } from "@shared/environment";

const defaultGatewayModel = "openai/gpt-5.6-sol-fast";

/** How a direct provider is named to people: in the cabinet, in privacy facts. */
const providerNames = {
  openrouter: "OpenRouter",
  routerai: "RouterAI",
} as const;

/**
 * The provider Bro's model calls go to directly instead of the AI Gateway,
 * whose free tier refuses most models. MODEL_PROVIDER picks it; left unset,
 * an OpenRouter key alone selects OpenRouter, as it did before RouterAI, and
 * without one every turn runs on the Gateway.
 */
export function directModelProvider() {
  if (env.MODEL_PROVIDER !== undefined) return env.MODEL_PROVIDER;
  return env.OPENROUTER_API_KEY === undefined ? undefined : "openrouter";
}

/**
 * Whether a direct provider serves the model: only then does a step carry
 * its tool choice, reply note and withheld tools (`agent/lib/model/direct.ts`).
 */
export function directModelActive() {
  return directModelProvider() !== undefined;
}

/** The direct provider's name, or `undefined` on the AI Gateway. */
export function directModelProviderName() {
  const provider = directModelProvider();
  return provider === undefined ? undefined : providerNames[provider];
}

/** Model a workspace uses until someone selects one for it. */
export function defaultModelId() {
  switch (directModelProvider()) {
    case "routerai":
      return env.ROUTERAI_MODEL;
    case "openrouter":
      return env.OPENROUTER_MODEL;
    default:
      return defaultGatewayModel;
  }
}
