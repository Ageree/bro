import { z } from "zod";
import { env } from "@shared/environment";
import { ModelStreamStalledError, watchedModelFetch } from "../stream-watchdog";

/**
 * Cloud.ru Foundation Models answers Bro's chat calls while the route to
 * RouterAI is down. On 03.10 the VM lost RouterAI for some 18 hours: first
 * RouterAI answered 500 for the account, then the route out of Cloud.ru
 * choked behind MSK-IX (a step's ~250 KB uploaded at a few KB/s, connect
 * timeouts, «other side closed», 503). Foundation Models lives inside the
 * same cloud and serves the DeepSeek family Bro runs on RouterAI, through an
 * OpenAI-compatible API with its own key.
 *
 * Only an outage of the route falls back: a network error, a connection
 * that sent nothing (`ModelStreamStalledError.idle`) or a 500/502/503/504,
 * whether as the HTTP status or as RouterAI's error inside an HTTP 200
 * (`routerai/fetch.ts`). A refusal (402 no credit, 400, 401) would be the
 * same anywhere and is RouterAI's to report. A call with `plugins` (web
 * search) has no counterpart there and fails as before.
 */
const backend = "Cloud.ru Foundation Models";

/** How long chat calls skip RouterAI once its route failed. */
const fallbackForMs = 5 * 60_000;

const routeFailureStatuses: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/**
 * Until when this process sends chat calls straight to Foundation Models,
 * and whether the call that tries RouterAI again is out: past the window the
 * first call probes RouterAI while the others keep to Foundation Models.
 */
let downUntil: number | undefined;
let probing = false;

/**
 * What of a chat call Foundation Models gets: the fields of OpenAI's chat
 * API. OpenRouter's own (`provider`, `reasoning`, `usage`, `transforms`,
 * `models`, `route`, `include_reasoning`, `top_k`, `debug`, …) are left out,
 * since whether Foundation Models takes them is unknown.
 */
const chatCallSchema = z.object({
  frequency_penalty: z.unknown().optional(),
  max_tokens: z.unknown().optional(),
  messages: z.array(z.unknown()),
  parallel_tool_calls: z.unknown().optional(),
  presence_penalty: z.unknown().optional(),
  response_format: z.unknown().optional(),
  seed: z.unknown().optional(),
  stop: z.unknown().optional(),
  stream: z.boolean().optional(),
  stream_options: z.unknown().optional(),
  temperature: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  tools: z.unknown().optional(),
  top_p: z.unknown().optional(),
});

const pluginsSchema = z.object({ plugins: z.array(z.unknown()).optional() });

/** A chat call's JSON body, unless it is none or carries a plugin. */
function chatCall(
  input: string | URL | Request,
  init: RequestInit | undefined
) {
  const url = URL.parse(input instanceof Request ? input.url : input);
  const body = z.string().safeParse(init?.body).data;
  if (!url?.pathname.endsWith("/chat/completions") || body === undefined) {
    return undefined;
  }
  try {
    const json: unknown = JSON.parse(body);
    const plugins = pluginsSchema.safeParse(json);
    if (!plugins.success || (plugins.data.plugins?.length ?? 0) > 0) {
      return undefined;
    }
    return chatCallSchema.safeParse(json).data;
  } catch {
    return undefined;
  }
}

/**
 * Sends the call to Foundation Models, as its model, with its key. Its
 * answer, or `undefined` when it failed too: the caller keeps RouterAI's
 * failure, which eve and «скоро вернусь» read as the outage it is.
 */
async function askFoundationModels(
  call: z.infer<typeof chatCallSchema>,
  init: RequestInit | undefined,
  key: string
) {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  const body = JSON.stringify({
    ...call,
    model: env.CLOUDRU_FM_MODEL,
    // A stream reports its tokens only when asked to.
    stream_options:
      call.stream_options ??
      (call.stream === true ? { include_usage: true } : undefined),
  });
  const url = `${env.CLOUDRU_FM_BASE_URL.replace(/\/+$/u, "")}/chat/completions`;
  try {
    const response = await watchedModelFetch(
      url,
      { ...init, body, headers },
      backend
    );
    if (response.ok) return response;
    await response.body?.cancel();
    console.warn("[model] cloudru-fm failed", { status: response.status });
    return undefined;
  } catch (error) {
    if (init?.signal?.aborted === true) throw error;
    console.warn("[model] cloudru-fm failed", {
      reason: error instanceof Error ? failureReason(error) : "unknown",
    });
    return undefined;
  }
}

const networkCodes = /^(?:E[A-Z]+|UND_ERR_[A-Z_]+|ERR_(?:SSL|TLS)_[A-Z_]+)$/u;

const failureSchema = z.object({
  cause: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
  code: z.string().optional(),
});

/**
 * Whether a thrown error is the route failing: undici's `fetch` throws a
 * `TypeError` for every network failure (a connect timeout, a reset, «other
 * side closed», TLS), and the watchdog a stall of a silent connection.
 */
function routeError(error: Error) {
  if (error instanceof ModelStreamStalledError) return error.idle;
  const failure = failureSchema.safeParse(error).data;
  const code = failure?.cause?.code ?? failure?.code;
  return (
    error instanceof TypeError ||
    (code !== undefined && networkCodes.test(code))
  );
}

/** A thrown error for the log: its cause's code and message, never a body. */
function failureReason(error: Error) {
  const cause = failureSchema.safeParse(error).data?.cause;
  const parts = [cause?.code, cause?.message].filter(
    (part) => part !== undefined
  );
  return (parts.length > 0 ? parts.join(": ") : error.message).slice(0, 160);
}

function routeDown(reason: string, probe: boolean) {
  const now = Date.now();
  if (!probe && downUntil !== undefined && now < downUntil) return;
  downUntil = now + fallbackForMs;
  console.warn("[model] fallback cloudru-fm on", { probe, reason });
}

function routeBack(reason: string) {
  if (downUntil === undefined) return;
  downUntil = undefined;
  console.info("[model] fallback cloudru-fm off", { reason });
}

/**
 * RouterAI's chat call with Foundation Models behind it (see `backend`
 * above). `routerAi` makes the call through RouterAI and reports the status
 * its answer failed with, if any. Without CLOUDRU_FM_API_KEY, or for a call
 * that has no counterpart there, it is all there is.
 */
export async function withFoundationModelsFallback(
  input: string | URL | Request,
  init: RequestInit | undefined,
  routerAi: () => Promise<{
    readonly answer: Response;
    readonly status: number;
  }>
): Promise<Response> {
  const key = env.CLOUDRU_FM_API_KEY;
  const call = key === undefined ? undefined : chatCall(input, init);
  if (key === undefined || call === undefined) return (await routerAi()).answer;

  if (downUntil !== undefined && (Date.now() < downUntil || probing)) {
    const answer = await askFoundationModels(call, init, key);
    if (answer !== undefined) return answer;
    // Foundation Models failed as well: RouterAI may be back.
    const outcome = await routerAi();
    if (!routeFailureStatuses.has(outcome.status)) {
      routeBack("cloudru-fm failed, RouterAI answered");
    }
    return outcome.answer;
  }

  const probe = downUntil !== undefined;
  if (probe) probing = true;
  try {
    let outcome: Awaited<ReturnType<typeof routerAi>>;
    try {
      outcome = await routerAi();
    } catch (error) {
      if (
        init?.signal?.aborted === true ||
        !(error instanceof Error) ||
        !routeError(error)
      ) {
        throw error;
      }
      routeDown(failureReason(error), probe);
      const answer = await askFoundationModels(call, init, key);
      if (answer !== undefined) return answer;
      throw error;
    }
    if (!routeFailureStatuses.has(outcome.status)) {
      if (probe) routeBack("RouterAI answered");
      return outcome.answer;
    }
    routeDown(`HTTP ${String(outcome.status)}`, probe);
    return (await askFoundationModels(call, init, key)) ?? outcome.answer;
  } finally {
    if (probe) probing = false;
  }
}
