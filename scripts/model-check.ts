import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_ROOT_CONTEXT_TOKENS,
  outputCapMiddleware,
  parseMaxOutputTokens,
} from "../agent/lib/model.ts";

import { assert, src } from "./lib/check.ts";

assert(
  parseMaxOutputTokens(undefined) === DEFAULT_MAX_OUTPUT_TOKENS,
  "undefined falls back to default",
);
assert(parseMaxOutputTokens("") === DEFAULT_MAX_OUTPUT_TOKENS, "empty string falls back to default");
assert(parseMaxOutputTokens("abc") === DEFAULT_MAX_OUTPUT_TOKENS, "non-numeric falls back to default");
assert(parseMaxOutputTokens("0") === DEFAULT_MAX_OUTPUT_TOKENS, "zero falls back to default");
assert(parseMaxOutputTokens("-5") === DEFAULT_MAX_OUTPUT_TOKENS, "negative falls back to default");
assert(parseMaxOutputTokens("4096") === 4096, "valid positive integer is used as-is");

const middleware = outputCapMiddleware(4096);
const capped = await middleware.transformParams!({
  type: "generate",
  params: { prompt: [], maxOutputTokens: undefined } as never,
  model: undefined as never,
});
assert(capped.maxOutputTokens === 4096, "unset maxOutputTokens gets the cap applied");

const uncapped = await middleware.transformParams!({
  type: "generate",
  params: { prompt: [], maxOutputTokens: 100 } as never,
  model: undefined as never,
});
assert(uncapped.maxOutputTokens === 100, "explicit maxOutputTokens is left unchanged");

process.env.OPENROUTER_API_KEY = "test";
const { broModel } = await import("../agent/lib/model.ts");
const result = broModel();
const model = result.model;
assert(typeof model === "object" && model !== null, "OpenRouter branch returns a model object");
const wrapped = model as Extract<typeof model, object>;

assert(typeof wrapped.provider === "string", "wrapped model has a string provider");
assert(
  DEFAULT_OPENROUTER_MODEL === "deepseek/deepseek-v4.1-flash",
  "default OpenRouter model is DeepSeek V4.1 Flash",
);
assert(wrapped.modelId === DEFAULT_OPENROUTER_MODEL, "wrapped model keeps the OpenRouter model id");
assert(typeof wrapped.doGenerate === "function", "wrapped model keeps doGenerate");
assert(typeof wrapped.doStream === "function", "wrapped model keeps doStream");
assert(
  "modelContextWindowTokens" in result && result.modelContextWindowTokens === 1_000_000,
  "default OpenRouter model reports its 1M context window",
);

const root = broModel({ contextTokens: DEFAULT_ROOT_CONTEXT_TOKENS });
assert(
  "modelContextWindowTokens" in root &&
    root.modelContextWindowTokens === DEFAULT_ROOT_CONTEXT_TOKENS,
  "root can advertise a compact window without changing the worker default",
);
assert(DEFAULT_MAX_OUTPUT_TOKENS === 8192, "output cap stays large enough for product dumps");
assert(DEFAULT_ROOT_CONTEXT_TOKENS >= 128_000, "root window still holds a live job thread");

const agentSrc = src("agent/agent.ts");
assert(agentSrc.includes("DEFAULT_ROOT_CONTEXT_TOKENS"), "root agent uses compact window");
assert(agentSrc.includes("compaction"), "root agent enables compaction");
assert(agentSrc.includes("broModel("), "root agent uses broModel");
assert(!agentSrc.includes('reasoning: "low"'), "root reasoning left default — do not dumb Bro down");

const otpSrc = src("agent/subagents/otp/agent.ts");
assert(otpSrc.includes("broModel()"), "otp stays on OpenRouter");

const workerSrc = src("agent/subagents/worker/agent.ts");
assert(workerSrc.includes("broModel("), "worker stays on OpenRouter");

const {
  OPENROUTER_CHAT_PREFERRED_MAX_LATENCY,
  OPENROUTER_CHAT_PROVIDER_SORT,
  OPENROUTER_CHAT_REASONING,
  applyOpenRouterChatDefaults,
  isOpenRouterChatCompletionsUrl,
  providerOrderFromEnv,
  reasoningFromEnv,
  withOpenRouterChatDefaults,
} = await import("../agent/lib/openrouter-chat.ts");
// DeepSeek V4.1 Flash thinks at effort=high by default and even `low` spends
// ~1,600 tokens before the first visible character. Chat turns run without a
// thinking phase; BRO_REASONING_EFFORT=low|high|max brings it back.
type Reasoning = ReturnType<typeof reasoningFromEnv>;
const reasoningOff = (r: Reasoning): boolean => "enabled" in r && r.enabled === false;
const reasoningEffort = (r: Reasoning): string | undefined => ("effort" in r ? r.effort : undefined);
assert(reasoningOff(OPENROUTER_CHAT_REASONING), "thinking is off by default so the first token is visible");
assert(reasoningOff(reasoningFromEnv({})), "unset env keeps thinking off");
assert(reasoningOff(reasoningFromEnv({ BRO_REASONING_EFFORT: "off" })), "off keeps thinking off");
assert(reasoningEffort(reasoningFromEnv({ BRO_REASONING_EFFORT: "low" })) === "low", "low re-enables low thinking");
assert(reasoningEffort(reasoningFromEnv({ BRO_REASONING_EFFORT: "MAX" })) === "max", "effort names are case-insensitive");
assert(reasoningOff(reasoningFromEnv({ BRO_REASONING_EFFORT: "none" })), "none is not a supported effort → off");
assert(OPENROUTER_CHAT_PROVIDER_SORT === "latency", "chat prefers the fastest OpenRouter provider");
assert(
  OPENROUTER_CHAT_PREFERRED_MAX_LATENCY.p90 <= 2.5,
  "slow hosts are deprioritized on p90, not required",
);
assert(providerOrderFromEnv({}) === undefined, "no pinned provider order by default (sticky cache stays on)");
assert(
  providerOrderFromEnv({ BRO_OPENROUTER_PROVIDER_ORDER: "Baseten, fireworks" })?.join(",") === "baseten,fireworks",
  "env pins a provider list",
);
const filled = withOpenRouterChatDefaults({ model: DEFAULT_OPENROUTER_MODEL }, {}) as {
  reasoning?: { effort?: string; enabled?: boolean };
  provider?: { sort?: string; order?: string[]; preferred_max_latency?: { p90?: number } };
};
assert(filled.reasoning?.enabled === false, "unset reasoning becomes disabled");
assert(filled.reasoning?.effort === undefined, "no effort is sent alongside enabled:false");
assert(filled.provider?.sort === "latency", "unset provider.sort becomes latency");
assert(filled.provider?.order === undefined, "no provider.order unless pinned by env");
assert(
  filled.provider?.preferred_max_latency?.p90 === OPENROUTER_CHAT_PREFERRED_MAX_LATENCY.p90,
  "unset preferred_max_latency deprioritizes slow hosts on p90",
);
const pinnedBody = withOpenRouterChatDefaults(
  { model: DEFAULT_OPENROUTER_MODEL },
  { BRO_OPENROUTER_PROVIDER_ORDER: "baseten", BRO_REASONING_EFFORT: "low" },
) as { reasoning?: { effort?: string; enabled?: boolean }; provider?: { sort?: string; order?: string[] } };
assert(pinnedBody.provider?.order?.[0] === "baseten", "env order is sent");
assert(pinnedBody.provider?.sort === undefined, "order and sort are never sent together");
assert(pinnedBody.reasoning?.effort === "low" && pinnedBody.reasoning?.enabled === undefined, "env effort is sent");
const kept = withOpenRouterChatDefaults({
  reasoning: { effort: "high" },
  provider: { sort: "price" },
}, {}) as { reasoning?: { effort?: string; enabled?: boolean }; provider?: { sort?: string } };
assert(kept.reasoning?.effort === "high", "explicit reasoning.effort is left alone");
assert(kept.reasoning?.enabled === undefined, "explicit effort is not contradicted by enabled:false");
assert(kept.provider?.sort === "price", "explicit provider.sort is left alone");
assert(
  isOpenRouterChatCompletionsUrl("https://openrouter.ai/api/v1/chat/completions"),
  "chat URL is recognized",
);
assert(
  !isOpenRouterChatCompletionsUrl("https://openrouter.ai/api/v1/auth/key"),
  "auth warmup is not rewritten",
);
const applied = applyOpenRouterChatDefaults({
  method: "POST",
  body: JSON.stringify({ model: DEFAULT_OPENROUTER_MODEL }),
});
const appliedBody = JSON.parse(String(applied?.body)) as {
  reasoning?: { enabled?: boolean };
};
assert(appliedBody.reasoning?.enabled === false, "fetch wrapper rewrites JSON chat bodies");

const modelSrc = src("agent/lib/model.ts");
assert(modelSrc.includes("openRouterChatFetch"), "default DeepSeek chat uses the OpenRouter extras fetch");
const warmSrc = src("agent/lib/openrouter-warm.ts");
assert(
  warmSrc.includes(`"${DEFAULT_OPENROUTER_MODEL}"`),
  "chat warm fallback stays on the same default model",
);

const {
  broModel: broModelResolved,
  openRouterModel,
} = await import("../agent/lib/model.ts");

assert(typeof openRouterModel === "function", "openRouterModel is exported");

const viaBro = broModelResolved();
const viaOpen = openRouterModel();
assert(typeof viaBro.model === "object" && viaBro.model !== null, "broModel is wrapped");
assert(typeof viaOpen.model === "object" && viaOpen.model !== null, "openRouterModel is wrapped");
const viaBroModel = viaBro.model as Extract<typeof viaBro.model, object>;
const viaOpenModel = viaOpen.model as Extract<typeof viaOpen.model, object>;
assert(viaBroModel.modelId === viaOpenModel.modelId, "openRouterModel matches broModel");

console.log("model:check OK");
