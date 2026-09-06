import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL_FALLBACKS,
  DEFAULT_OPENROUTER_CONTEXT_TOKENS,
  DEFAULT_OPENROUTER_MODEL,
  PAID_GLM_MODEL,
  outputCapMiddleware,
  parseMaxOutputTokens,
  parseModelCascade,
  parseOpenRouterKeys,
} from "../agent/lib/model.ts";
import { createOpenRouterFetch, rewriteChatModel } from "../agent/lib/openrouter-fetch.ts";
import {
  KEY_COOLDOWN_402_MS,
  contextTokensFor,
  createKeyPool,
  pickKey,
  shouldAdvanceModel,
  shouldRotateKey,
} from "../agent/lib/openrouter-pool.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq<T>(got: T, want: T, msg: string): void {
  if (got !== want) throw new Error(`${msg}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
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

eq(DEFAULT_OPENROUTER_MODEL, "openrouter/free", "default is the free router");
assert(DEFAULT_MODEL_FALLBACKS.every((m) => m.includes(":free")), "default fallbacks are free");

eq(parseOpenRouterKeys({}).length, 0, "no keys");
assert(
  JSON.stringify(parseOpenRouterKeys({ OPENROUTER_API_KEY: " a ", OPENROUTER_API_KEYS: "b,a\nc" })) ===
    JSON.stringify(["a", "b", "c"]),
  "keys merge and dedupe",
);

assert(
  JSON.stringify(parseModelCascade({})) ===
    JSON.stringify(["openrouter/free", ...DEFAULT_MODEL_FALLBACKS]),
  "default cascade is free-first",
);
assert(
  JSON.stringify(parseModelCascade({ BRO_MODEL: "z-ai/glm-5.3-flash", BRO_MODEL_FALLBACKS: "" })) ===
    JSON.stringify(["z-ai/glm-5.3-flash"]),
  "empty fallbacks disables extras",
);
eq(
  contextTokensFor("openrouter/free", {}),
  DEFAULT_OPENROUTER_CONTEXT_TOKENS,
  "free router window",
);
eq(contextTokensFor(PAID_GLM_MODEL, {}), 1_000_000, "paid glm window");
eq(contextTokensFor("custom/x", { BRO_MODEL_CONTEXT_TOKENS: "64000" }), 64000, "override window");

assert(shouldRotateKey(429) && shouldRotateKey(402) && shouldRotateKey(401), "rotate on quota");
assert(!shouldRotateKey(400), "plain 400 does not rotate keys");
assert(shouldAdvanceModel(404, ""), "404 advances model");
assert(shouldAdvanceModel(400, "No endpoints found for model"), "missing model advances");
assert(!shouldAdvanceModel(400, "invalid json"), "bad request stays");

{
  let now = 1_000;
  const pool = createKeyPool(["k1", "k2"], { now: () => now });
  eq(pickKey(pool, new Set()), "k1", "round-robin first");
  eq(pickKey(pool, new Set()), "k2", "round-robin second");
  pool.markFailure("k1", 402, now);
  eq(pool.healthyCount(now), 1, "402 cools one key");
  eq(pickKey(pool, new Set()), "k2", "skips cooled key");
  now += KEY_COOLDOWN_402_MS + 1;
  eq(pool.healthyCount(now), 2, "402 cooldown expires");
}

{
  const calls: Array<{ auth: string; model: string }> = [];
  const rotating = createOpenRouterFetch({
    keys: ["dead", "live"],
    models: ["openrouter/free", "z-ai/glm-5.2:free"],
    fetch: (async (_url, init) => {
      const auth = String(new Headers(init?.headers).get("Authorization"));
      const body = JSON.parse(String(init?.body)) as { model: string };
      calls.push({ auth, model: body.model });
      if (auth.endsWith("dead")) {
        return new Response("rate", { status: 429 });
      }
      if (body.model === "openrouter/free") {
        return new Response("no endpoints found for model", { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  });
  const res = await rotating("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "ignored", messages: [] }),
  });
  assert(res.ok, "rotating fetch eventually succeeds");
  eq(calls[0]?.auth, "Bearer dead", "first key");
  eq(calls[1]?.auth, "Bearer live", "second key after 429");
  eq(calls[1]?.model, "openrouter/free", "still primary model");
  eq(calls[2]?.model, "z-ai/glm-5.2:free", "advances model after 400");
  eq(calls.length, 3, "dead+free, live+free, live+fallback");
}

{
  const calls: string[] = [];
  const rotating = createOpenRouterFetch({
    keys: ["only"],
    models: ["openrouter/free"],
    fetch: (async (_url, init) => {
      calls.push(String(init?.body));
      return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
    }) as typeof fetch,
  });
  const res = await rotating("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "openrouter/free", messages: [] }),
  });
  eq(res.status, 400, "non-model 400 is not retried");
  eq(calls.length, 1, "single attempt on bad request");
}

eq(
  rewriteChatModel(JSON.stringify({ model: "a", n: 1 }), "b"),
  JSON.stringify({ model: "b", n: 1 }),
  "rewrite replaces model",
);

// broModel(): OpenRouter branch is wrapped but still exposes a runtime language model
process.env.OPENROUTER_API_KEY = "test";
delete process.env.BRO_MODEL;
delete process.env.BRO_MODEL_FALLBACKS;
const { broModel } = await import("../agent/lib/model.ts");
const result = broModel({ OPENROUTER_API_KEY: "test" });
const model = result.model;
assert(typeof model === "object" && model !== null, "OpenRouter branch returns a model object");
const wrapped = model as Extract<typeof model, object>;

assert(typeof wrapped.provider === "string", "wrapped model has a string provider");
assert(wrapped.modelId === "openrouter/free", "default model is the free router");
assert(typeof wrapped.doGenerate === "function", "wrapped model keeps doGenerate");
assert(typeof wrapped.doStream === "function", "wrapped model keeps doStream");
assert(
  "modelContextWindowTokens" in result &&
    result.modelContextWindowTokens === DEFAULT_OPENROUTER_CONTEXT_TOKENS,
  "default OpenRouter model reports the free-router context window",
);

const paid = broModel({
  OPENROUTER_API_KEY: "test",
  BRO_MODEL: PAID_GLM_MODEL,
  BRO_MODEL_FALLBACKS: "",
});
const paidModel = paid.model as Extract<typeof paid.model, object>;
eq(paidModel.modelId, PAID_GLM_MODEL, "explicit paid model");
assert(
  "modelContextWindowTokens" in paid && paid.modelContextWindowTokens === 1_000_000,
  "paid glm keeps 1M context",
);

const keysOnly = broModel({ OPENROUTER_API_KEYS: "sk-or-one,sk-or-two" });
assert(typeof keysOnly.model === "object", "OPENROUTER_API_KEYS alone is enough");

const gateway = broModel({});
eq(gateway.model, "openai/gpt-5.4-mini", "no keys → AI Gateway fallback");

console.log("model:check OK");
