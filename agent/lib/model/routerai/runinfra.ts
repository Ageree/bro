import { z } from "zod";
import { env } from "@shared/environment";
import { watchedModelFetch } from "../stream-watchdog";

/**
 * RunInfra serves Bro's chat model ahead of RouterAI. Measured 11.10 on a
 * step of 63k tokens with a forced `send_message`: the first token in
 * 0.9–1.0 s with a warm cache, against 2.3–2.9 s through RouterAI on
 * DeepInfra; a cached step costs about $0.0013 (≈0.11 ₽, RouterAI ≈0.04 ₽).
 *
 * Only the models RunInfra hosts go there (`hosted`); every other model,
 * every call with `plugins` (web search) and every raw call stays on
 * RouterAI. Any failure of RunInfra — a thrown fetch, a status other than
 * 2xx, an error inside the answer — sends the same call to RouterAI at once,
 * and the calls of the next five minutes skip RunInfra, then one tries it
 * again. The answer is read whole before it is passed on, as RouterAI's is
 * (`fetch.ts`): a failure can come at its end, and nothing of a failed
 * answer may reach eve.
 */
const backend = "RunInfra";

/** Bro's model ids on RouterAI and the ids RunInfra serves them under. */
const hosted: ReadonlyMap<string, string> = new Map([
  ["deepseek/deepseek-v4.1-flash", "deepseek-v4-1-flash"],
]);

/** How long chat calls skip RunInfra once it failed one. */
const skipForMs = 5 * 60_000;

let downUntil: number | undefined;

/**
 * What of a chat call RunInfra gets: the fields of OpenAI's chat API. The
 * OpenRouter ones (`provider`, `usage`, `transforms`, `plugins`, …) are left
 * out; `reasoning` is translated into `reasoning_effort`.
 */
const chatCallSchema = z.object({
  frequency_penalty: z.number().optional(),
  max_tokens: z.number().optional(),
  messages: z.array(z.json()),
  model: z.string(),
  parallel_tool_calls: z.boolean().optional(),
  plugins: z.array(z.json()).optional(),
  presence_penalty: z.number().optional(),
  reasoning: z
    .object({
      effort: z.string().optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
  response_format: z.json().optional(),
  seed: z.number().optional(),
  stop: z.json().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  tool_choice: z.json().optional(),
  tools: z.array(z.json()).optional(),
  top_p: z.number().optional(),
});

type ChatCall = z.infer<typeof chatCallSchema>;

/** The call's JSON body, when it is a chat call RunInfra can serve. */
function servedCall(
  input: string | URL | Request,
  init: RequestInit | undefined
) {
  const url = URL.parse(input instanceof Request ? input.url : input);
  const body = z.string().safeParse(init?.body).data;
  if (!url?.pathname.endsWith("/chat/completions") || body === undefined) {
    return undefined;
  }
  try {
    const call = chatCallSchema.safeParse(JSON.parse(body)).data;
    if (call === undefined || (call.plugins?.length ?? 0) > 0) return undefined;
    const model = hosted.get(call.model);
    return model === undefined ? undefined : { call, model };
  } catch {
    return undefined;
  }
}

/** OpenRouter's `reasoning` as RunInfra's `reasoning_effort`. */
function reasoningEffort(reasoning: ChatCall["reasoning"]) {
  if (reasoning === undefined) return undefined;
  if (reasoning.enabled === false || reasoning.effort === "none") return "none";
  return reasoning.effort;
}

/** The body RunInfra gets: OpenAI's fields, its model id, usage asked for. */
export function runInfraBody(call: ChatCall, model: string) {
  return JSON.stringify({
    frequency_penalty: call.frequency_penalty,
    max_tokens: call.max_tokens,
    messages: call.messages,
    model,
    parallel_tool_calls: call.parallel_tool_calls,
    presence_penalty: call.presence_penalty,
    reasoning_effort: reasoningEffort(call.reasoning),
    response_format: call.response_format,
    seed: call.seed,
    stop: call.stop,
    stream: call.stream,
    temperature: call.temperature,
    tool_choice: call.tool_choice,
    tools: call.tools,
    top_p: call.top_p,
    // A stream reports its tokens only when asked to.
    stream_options: call.stream === true ? { include_usage: true } : undefined,
  });
}

const usageSchema = z.looseObject({
  usage: z.looseObject({ cost: z.number() }),
});

/**
 * RunInfra prices in dollars and RouterAI in roubles, which is what the
 * rest of Bro reads `usage.cost` as (`agent/lib/model/direct.ts`): the cost
 * of RunInfra's answer is put in roubles at USAGE_USD_RUB.
 */
function inRoubles(json: string) {
  try {
    const answer = usageSchema.safeParse(JSON.parse(json)).data;
    if (answer === undefined) return json;
    return JSON.stringify({
      ...answer,
      usage: { ...answer.usage, cost: answer.usage.cost * env.USAGE_USD_RUB },
    });
  } catch {
    return json;
  }
}

const failedAnswerSchema = z.looseObject({ error: z.json() });

/** Whether one JSON answer, or one event of a stream, is a failure. */
function failed(json: string) {
  try {
    return failedAnswerSchema.safeParse(JSON.parse(json)).success;
  } catch {
    return false;
  }
}

/**
 * RunInfra's answer in the form Bro reads, or `undefined` when it failed:
 * the cost in roubles, nothing else touched.
 */
export function readRunInfraAnswer(text: string, eventStream: boolean) {
  if (!eventStream) return failed(text) ? undefined : inRoubles(text);
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : undefined;
    if (payload === undefined || payload === "[DONE]" || payload === "") {
      out.push(line);
      continue;
    }
    if (failed(payload)) return undefined;
    out.push(`data: ${inRoubles(payload)}`);
  }
  return out.join("\n");
}

async function askRunInfra(
  served: { readonly call: ChatCall; readonly model: string },
  init: RequestInit | undefined,
  key: string
) {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("content-type", "application/json");
  const url = `${env.RUNINFRA_BASE_URL.replace(/\/+$/u, "")}/chat/completions`;
  try {
    const response = await watchedModelFetch(
      url,
      {
        ...init,
        body: runInfraBody(served.call, served.model),
        headers,
      },
      backend
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return { failure: `HTTP ${String(response.status)}` };
    }
    const eventStream = (response.headers.get("content-type") ?? "").includes(
      "text/event-stream"
    );
    const text = readRunInfraAnswer(await response.text(), eventStream);
    if (text === undefined) return { failure: "error in the answer" };
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    return {
      answer: new Response(text, {
        headers: responseHeaders,
        status: response.status,
        statusText: response.statusText,
      }),
    };
  } catch (error) {
    if (init?.signal?.aborted === true) throw error;
    return {
      failure: error instanceof Error ? error.message.slice(0, 160) : "thrown",
    };
  }
}

/**
 * The chat call through RunInfra when it serves the model, else (and on any
 * failure of RunInfra) through `routerAi`. Without RUNINFRA_API_KEY RunInfra
 * is never asked.
 */
export async function withRunInfraFirst(
  input: string | URL | Request,
  init: RequestInit | undefined,
  routerAi: () => Promise<Response>
): Promise<Response> {
  const key = env.RUNINFRA_API_KEY;
  const served = key === undefined ? undefined : servedCall(input, init);
  if (key === undefined || served === undefined) return routerAi();
  if (downUntil !== undefined && Date.now() < downUntil) return routerAi();
  const outcome = await askRunInfra(served, init, key);
  if (outcome.answer !== undefined) {
    if (downUntil !== undefined) {
      downUntil = undefined;
      console.info("[model] runinfra back");
    }
    return outcome.answer;
  }
  downUntil = Date.now() + skipForMs;
  console.warn("[model] runinfra failed, RouterAI answers", {
    reason: outcome.failure,
  });
  return routerAi();
}
