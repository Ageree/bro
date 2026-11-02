import { z } from "zod";
import { env } from "@shared/environment";
import { watchedModelFetch } from "../stream-watchdog";
import { failed, runInfraBody, servedCall, type ChatCall } from "./runinfra";

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
 * BeatAPI's `deepseek-v4.1-flash` does not force a tool: `tool_choice`
 * `required` or a named function came back as plain text in 4–8 of 12 calls
 * (checked 02.11; RouterAI, APInex and OrcaRouter obey on the same model),
 * and Bro forces `send_message` through it. So a call that forces a tool
 * carries a short system note as its last message (`forcedToolNote`: 24 of 24
 * calls answered with a tool call; the prompt before it stays as it is, and
 * the cache read stays 99%), and an answer that still has no tool call goes
 * to the next backend, which forces it properly — no outage of BeatAPI.
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

const forcedChoiceSchema = z.union([
  z.literal("required"),
  z.looseObject({ function: z.looseObject({ name: z.string() }) }),
]);

/**
 * What a forced call is told last, as BeatAPI does not force it: the tool
 * named, else any tool. It names no tool Bro would rather have called: a note
 * pointing at `send_message` made the model reply in words where a reaction
 * was due (a smoke eval, 02.11). Nothing for a call that leaves the choice
 * to the model. In English, so it does not pull the language of the answer.
 */
function forcedToolNote(call: ChatCall) {
  const choice = forcedChoiceSchema.safeParse(call.tool_choice).data;
  if (choice === undefined) return undefined;
  if (choice !== "required") {
    return `Required: call the ${choice.function.name} tool. Plain text without a tool call is not allowed.`;
  }
  return "Required: respond with a tool call only. Plain text without a tool call is not allowed.";
}

const toolCallSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z.looseObject({ tool_calls: z.array(z.json()) }).optional(),
        message: z.looseObject({ tool_calls: z.array(z.json()) }).optional(),
      })
    )
    .optional(),
});

/** Whether the answer, or any event of the stream, has a tool call. */
function hasToolCall(text: string, eventStream: boolean) {
  const bodies = eventStream
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [text];
  return bodies.some((body) => {
    try {
      return (
        toolCallSchema.safeParse(JSON.parse(body)).data?.choices ?? []
      ).some(
        (choice) =>
          (choice.delta?.tool_calls.length ?? 0) > 0 ||
          (choice.message?.tool_calls.length ?? 0) > 0
      );
    } catch {
      return false;
    }
  });
}

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
  served: { readonly call: ChatCall; readonly model: string },
  init: RequestInit | undefined,
  key: string
) {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("content-type", "application/json");
  const url = `${env.BEATAPI_BASE_URL.replace(/\/+$/u, "")}/chat/completions`;
  const note = forcedToolNote(served.call);
  const call =
    note === undefined
      ? served.call
      : {
          ...served.call,
          messages: [
            ...served.call.messages,
            { content: note, role: "system" },
          ],
        };
  try {
    const response = await watchedModelFetch(
      url,
      { ...init, body: runInfraBody(call, served.model), headers },
      backend
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      // A key over its requests per minute (a lifetime top-up decides how
      // many) is asked again when BeatAPI says so, not in five minutes.
      const wait = Number(response.headers.get("retry-after"));
      return {
        failure: `HTTP ${String(response.status)}`,
        outage: true,
        retryAfterMs:
          response.status === 429 && wait > 0
            ? Math.min(wait, 60) * 1000
            : undefined,
      };
    }
    const eventStream = (response.headers.get("content-type") ?? "").includes(
      "text/event-stream"
    );
    const text = readAnswer(await response.text(), eventStream);
    if (text === undefined)
      return {
        failure: "error in the answer",
        outage: true,
        retryAfterMs: undefined,
      };
    if (note !== undefined && !hasToolCall(text, eventStream)) {
      return {
        failure: "no tool call",
        outage: false,
        retryAfterMs: undefined,
      };
    }
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
      outage: true,
      retryAfterMs: undefined,
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
  if (downUntil !== undefined && Date.now() < downUntil) return next();
  const outcome = await askBeatApi(served, init, key);
  if (outcome.answer !== undefined) {
    if (downUntil !== undefined) {
      downUntil = undefined;
      console.info("[model] beatapi back");
    }
    return outcome.answer;
  }
  // An answer without the forced tool call is no outage: the next call tries
  // BeatAPI again.
  if (outcome.outage) {
    downUntil = Date.now() + (outcome.retryAfterMs ?? skipForMs);
  }
  console.warn("[model] beatapi failed, the next backend answers", {
    reason: outcome.failure,
  });
  return next();
}
