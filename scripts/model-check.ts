import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_ROOT_CONTEXT_TOKENS,
  outputCapMiddleware,
  parseMaxOutputTokens,
} from "../agent/lib/model.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

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
assert(wrapped.modelId === "z-ai/glm-5.3-flash", "wrapped model keeps the OpenRouter model id");
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

const agentSrc = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../agent/agent.ts", import.meta.url), "utf8"),
);
assert(agentSrc.includes("DEFAULT_ROOT_CONTEXT_TOKENS"), "root agent uses compact window");
assert(agentSrc.includes("compaction"), "root agent enables compaction");
assert(agentSrc.includes("step.started"), "root model resolves on step.started");
assert(agentSrc.includes("resolveBroModelForTurn"), "root uses the ChatGPT-aware resolver");
assert(!agentSrc.includes("turn.started"), "root model is not resolved on turn.started");
assert(!agentSrc.includes('reasoning: "low"'), "root reasoning left default — do not dumb Bro down");

const otpSrc = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../agent/subagents/otp/agent.ts", import.meta.url), "utf8"),
);
assert(otpSrc.includes("broModel()"), "otp stays on OpenRouter");
assert(!otpSrc.includes("resolveBroModelForTurn"), "otp does not use Codex");

const {
  OPENROUTER_CHAT_PREFERRED_MAX_LATENCY,
  OPENROUTER_CHAT_PROVIDER_ORDER,
  OPENROUTER_CHAT_PROVIDER_SORT,
  OPENROUTER_CHAT_REASONING_EFFORT,
  applyOpenRouterChatDefaults,
  isOpenRouterChatCompletionsUrl,
  withOpenRouterChatDefaults,
} = await import("../agent/lib/openrouter-chat.ts");
assert(OPENROUTER_CHAT_REASONING_EFFORT === "low", "GLM default max is overridden to low");
assert(OPENROUTER_CHAT_PROVIDER_SORT === "latency", "chat prefers the fastest OpenRouter provider");
assert(
  OPENROUTER_CHAT_PROVIDER_ORDER[0] === "parasail",
  "fast GLM hosts are tried before Z.ai",
);
assert(
  OPENROUTER_CHAT_PREFERRED_MAX_LATENCY <= 1.5,
  "slow hosts are deprioritized, not required",
);
const filled = withOpenRouterChatDefaults({ model: "z-ai/glm-5.3-flash" }) as {
  reasoning?: { effort?: string };
  provider?: { sort?: string; order?: string[]; preferred_max_latency?: number };
};
assert(filled.reasoning?.effort === "low", "unset reasoning.effort becomes low");
assert(filled.provider?.sort === "latency", "unset provider.sort becomes latency");
assert(
  filled.provider?.order?.[0] === "parasail",
  "unset provider.order prefers fast GLM hosts",
);
assert(
  filled.provider?.preferred_max_latency === OPENROUTER_CHAT_PREFERRED_MAX_LATENCY,
  "unset preferred_max_latency deprioritizes Z.ai-class hosts",
);
const kept = withOpenRouterChatDefaults({
  reasoning: { effort: "high" },
  provider: { sort: "price" },
}) as { reasoning?: { effort?: string }; provider?: { sort?: string } };
assert(kept.reasoning?.effort === "high", "explicit reasoning.effort is left alone");
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
  body: JSON.stringify({ model: "z-ai/glm-5.3-flash" }),
});
const appliedBody = JSON.parse(String(applied?.body)) as {
  reasoning?: { effort?: string };
};
assert(appliedBody.reasoning?.effort === "low", "fetch wrapper rewrites JSON chat bodies");

const modelSrc = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../agent/lib/model.ts", import.meta.url), "utf8"),
);
assert(modelSrc.includes("openRouterChatFetch"), "default GLM chat uses the OpenRouter extras fetch");

const {
  resolveBroModel,
  broModel: broModelResolved,
  openRouterModel,
  CODEX_CONTEXT_WINDOW_TOKENS,
  DEFAULT_CODEX_MODEL,
} = await import("../agent/lib/model.ts");

assert(typeof openRouterModel === "function", "openRouterModel is exported");
assert(DEFAULT_CODEX_MODEL === "gpt-5.6-sol", "Codex default stays eve gpt-5.6-sol");

const viaBro = broModelResolved();
const viaOpen = openRouterModel();
assert(typeof viaBro.model === "object" && viaBro.model !== null, "broModel is wrapped");
assert(typeof viaOpen.model === "object" && viaOpen.model !== null, "openRouterModel is wrapped");
const viaBroModel = viaBro.model as Extract<typeof viaBro.model, object>;
const viaOpenModel = viaOpen.model as Extract<typeof viaOpen.model, object>;
assert(viaBroModel.modelId === viaOpenModel.modelId, "openRouterModel matches broModel");

const fakeBroker = {
  getToken: async () => ({ accessToken: "tok", accountId: "acct" }),
};

for (const chatgpt of ["none", "pending", "quarantined"] as const) {
  const resolved = resolveBroModel({ isGroup: false, chatgpt });
  assert(typeof resolved.model === "object" && resolved.model !== null, `${chatgpt} is wrapped`);
  const resolvedModel = resolved.model as Extract<typeof resolved.model, object>;
  assert(resolvedModel.modelId === viaBroModel.modelId, `${chatgpt} stays on OpenRouter`);
}

const groupResolved = resolveBroModel(
  { isGroup: true, chatgpt: "connected" },
  { broker: fakeBroker },
);
assert(typeof groupResolved.model === "object" && groupResolved.model !== null, "group is wrapped");
const groupModel = groupResolved.model as Extract<typeof groupResolved.model, object>;
assert(groupModel.modelId === viaBroModel.modelId, "group + connected still uses OpenRouter");

const noBroker = resolveBroModel({ isGroup: false, chatgpt: "connected" });
assert(typeof noBroker.model === "object" && noBroker.model !== null, "no-broker is wrapped");
const noBrokerModel = noBroker.model as Extract<typeof noBroker.model, object>;
assert(noBrokerModel.modelId === viaBroModel.modelId, "connected without a broker stays on OpenRouter");

const codexResolved = resolveBroModel(
  { isGroup: false, chatgpt: "connected" },
  { broker: fakeBroker },
);
assert(
  "modelContextWindowTokens" in codexResolved &&
    codexResolved.modelContextWindowTokens === CODEX_CONTEXT_WINDOW_TOKENS,
  "connected + broker advertises the 200k Codex window",
);
assert(
  typeof codexResolved.model === "object" &&
    codexResolved.model !== null &&
    typeof (codexResolved.model as { doGenerate?: unknown }).doGenerate === "function" &&
    typeof (codexResolved.model as { doStream?: unknown }).doStream === "function",
  "connected + broker returns a live LanguageModel",
);
const codexModel = codexResolved.model as { modelId?: unknown };
assert(codexModel.modelId === DEFAULT_CODEX_MODEL, "Codex branch uses BRO_CODEX_MODEL default");

console.log("model:check OK");
