import { z } from "zod";
import { env } from "@shared/environment";
import { watchedModelFetch } from "../stream-watchdog";
import { failed, runInfraBody, servedCall } from "./runinfra";

/**
 * BeatAPI serves Bro's chat model ahead of RunInfra and RouterAI, for the
 * price. Measured 02.11 on a step of 47k tokens: 99.5% of the input is read
 * from the prompt cache from the second call on, a step takes 2.9–4.2 s
 * (RouterAI 3.4–7 s, RunInfra ≈1.5 s), and the tool calls come out right.
 * A cached step costs about $0.00009 (≈0.007 ₽) against ≈0.04 ₽ at RouterAI
 * and ≈0.11 ₽ at RunInfra.
 *
 * Only the model it hosts goes there (`hosted`); a call with `plugins` (web
 * search) or a picture or file, and every raw call, stays on the next
 * backend, and so does any call BeatAPI fails — a thrown fetch, a status
 * other than 2xx, an error inside the answer: the calls of the next five
 * minutes skip BeatAPI, then one tries it again. As for RunInfra, the answer
 * is read whole before it is passed on: a failure can come at its end.
 *
 * BeatAPI's `deepseek-v4.1-flash` ignores `tool_choice` — `required` and a
 * named function both come back as plain text (checked 02.11; RouterAI,
 * APInex and OrcaRouter obey on the same model) — while Bro forces
 * `send_message` through it, so a call that forces a tool never goes there
 * (`forcesTool`). Its `deepseek-v4-flash-0731` and `deepseek-v4-pro-0813` do
 * obey, but they are other models: switching to one is a quality question for
 * the benchmark, not a mapping to change here.
 */
const backend = "BeatAPI";

/** Bro's model ids on RouterAI and the ids BeatAPI serves them under. */
const hosted: ReadonlyMap<string, string> = new Map([
  ["deepseek/deepseek-v4.1-flash", env.BEATAPI_DEEPSEEK_FLASH_MODEL],
]);

/**
 * BeatAPI's price of the `deepseek` group, dollars per million tokens: its
 * list price ($0.15 / $0.60 / $0.003) times the group's ratio 0.5. It bills
 * by the same formula, and its answer carries no cost of its own.
 */
const dollarsPerMillion = { cached: 0.0015, input: 0.075, output: 0.3 };

/** A call that leaves the choice of tool to the model: only `auto` and `none`. */
const freeToolChoice = z.union([
  z.undefined(),
  z.literal("auto"),
  z.literal("none"),
]);

const skipForMs = 5 * 60_000;

let downUntil: number | undefined;

const usageSchema = z.looseObject({
  usage: z
    .looseObject({
      completion_tokens: z.number(),
      prompt_cache_hit_tokens: z.number().optional(),
      prompt_cache_miss_tokens: z.number().optional(),
      prompt_tokens: z.number(),
    })
    .nullish(),
});

/**
 * One answer or stream event with `usage.cost` put in roubles (Bro reads it
 * so, `direct.ts`): the tokens priced at BeatAPI's rates and USAGE_USD_RUB.
 * An event without usage stays as it is.
 */
function withCost(json: string) {
  try {
    const answer = usageSchema.safeParse(JSON.parse(json)).data;
    const usage = answer?.usage;
    if (answer === undefined || usage === undefined || usage === null) {
      return json;
    }
    const cached = usage.prompt_cache_hit_tokens ?? 0;
    const missed = usage.prompt_cache_miss_tokens ?? usage.prompt_tokens;
    const dollars =
      (cached * dollarsPerMillion.cached +
        missed * dollarsPerMillion.input +
        usage.completion_tokens * dollarsPerMillion.output) /
      1_000_000;
    return JSON.stringify({
      ...answer,
      usage: { ...usage, cost: dollars * env.USAGE_USD_RUB },
    });
  } catch {
    return json;
  }
}

/** BeatAPI's answer in the form Bro reads, or `undefined` when it failed. */
function readAnswer(text: string, eventStream: boolean) {
  if (!eventStream) return failed(text) ? undefined : withCost(text);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : undefined;
    if (payload === undefined || payload === "[DONE]" || payload === "") {
      out.push(line);
      continue;
    }
    if (failed(payload)) return undefined;
    out.push(`data: ${withCost(payload)}`);
  }
  return out.join("\n");
}

async function askBeatApi(
  served: { readonly call: Parameters<typeof runInfraBody>[0]; model: string },
  init: RequestInit | undefined,
  key: string
) {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("content-type", "application/json");
  const url = `${env.BEATAPI_BASE_URL.replace(/\/+$/u, "")}/chat/completions`;
  try {
    const response = await watchedModelFetch(
      url,
      { ...init, body: runInfraBody(served.call, served.model), headers },
      backend
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return { failure: `HTTP ${String(response.status)}` };
    }
    const eventStream = (response.headers.get("content-type") ?? "").includes(
      "text/event-stream"
    );
    const text = readAnswer(await response.text(), eventStream);
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
 * The chat call through BeatAPI when it serves the model, else (and on any
 * failure of BeatAPI) through `next`. Without BEATAPI_API_KEY BeatAPI is
 * never asked.
 */
export async function withBeatApiFirst(
  input: string | URL | Request,
  init: RequestInit | undefined,
  next: () => Promise<Response>
): Promise<Response> {
  const key = env.BEATAPI_API_KEY;
  const served =
    key === undefined ? undefined : servedCall(input, init, hosted);
  if (key === undefined || served === undefined) return next();
  // BeatAPI does not force a tool (see above): the call goes on as it is.
  if (!freeToolChoice.safeParse(served.call.tool_choice).success) return next();
  if (downUntil !== undefined && Date.now() < downUntil) return next();
  const outcome = await askBeatApi(served, init, key);
  if (outcome.answer !== undefined) {
    if (downUntil !== undefined) {
      downUntil = undefined;
      console.info("[model] beatapi back");
    }
    return outcome.answer;
  }
  downUntil = Date.now() + skipForMs;
  console.warn("[model] beatapi failed, the next backend answers", {
    reason: outcome.failure,
  });
  return next();
}
