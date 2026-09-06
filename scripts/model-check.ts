import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  outputCapMiddleware,
  parseMaxOutputTokens,
} from "../agent/lib/model.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// parseMaxOutputTokens: env override or default fallback
assert(
  parseMaxOutputTokens(undefined) === DEFAULT_MAX_OUTPUT_TOKENS,
  "undefined falls back to default",
);
assert(parseMaxOutputTokens("") === DEFAULT_MAX_OUTPUT_TOKENS, "empty string falls back to default");
assert(parseMaxOutputTokens("abc") === DEFAULT_MAX_OUTPUT_TOKENS, "non-numeric falls back to default");
assert(parseMaxOutputTokens("0") === DEFAULT_MAX_OUTPUT_TOKENS, "zero falls back to default");
assert(parseMaxOutputTokens("-5") === DEFAULT_MAX_OUTPUT_TOKENS, "negative falls back to default");
assert(parseMaxOutputTokens("4096") === 4096, "valid positive integer is used as-is");

// outputCapMiddleware: only fills maxOutputTokens when the caller left it unset
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

// broModel(): OpenRouter branch is wrapped but still exposes a runtime language model
process.env.OPENROUTER_API_KEY = "test";
const { broModel } = await import("../agent/lib/model.ts");
const result = broModel();
const model = result.model;
assert(typeof model === "object" && model !== null, "OpenRouter branch returns a model object");
const wrapped = model as Extract<typeof model, object>;

assert(typeof wrapped.provider === "string", "wrapped model has a string provider");
assert(wrapped.modelId === "z-ai/glm-5.3-flash", "wrapped model keeps the OpenRouter model id");
assert(typeof wrapped.doGenerate === "function", "wrapped model keeps doGenerate");
assert(typeof wrapped.doStream === "function", "wrapped model keeps doStream");
assert(
  "modelContextWindowTokens" in result && result.modelContextWindowTokens === 1_000_000,
  "default OpenRouter model reports its 1M context window",
);

console.log("model:check OK");
