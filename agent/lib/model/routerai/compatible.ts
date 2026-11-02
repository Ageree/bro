import { z } from "zod";
import { env } from "@shared/environment";
import { watchedModelFetch } from "../stream-watchdog";
import { failed, runInfraBody, servedCall, type ChatCall } from "./runinfra";

/**
 * A cheaper OpenAI-compatible backend for the chat model, tried ahead of
 * RunInfra and RouterAI (`beatapi.ts`, `orcarouter.ts` are its settings).
 * Only the models it hosts go there (`models`); a call with `plugins` (web
 * search) or a picture or file, and every raw call, stays on the next
 * backend, and so does any call it fails — a thrown fetch, a status other
 * than 2xx, an error inside the answer: the calls of the next five minutes
 * skip it (a 429 only for its Retry-After), then one tries it again. As for
 * RunInfra, the answer is read whole before it is passed on: a failure can
 * come at its end.
 *
 * Its answer carries no cost, so `usage.cost` is put in roubles from the
 * tokens at its `rates` and USAGE_USD_RUB (Bro reads it so, `direct.ts`).
 *
 * `forcesTools: false` is for a backend whose model ignores `tool_choice`
 * (BeatAPI's `deepseek-v4.1-flash`: `required` or a named function came back
 * as plain text in 4–8 of 12 calls, 02.11), while Bro forces `send_message`
 * through it. Such a call carries a short system note as its last message
 * (`forcedToolNote`: 24 of 24 calls answered with a tool call; the prompt
 * before it stays as it is and the cache read stays 99%), and an answer that
 * still has no tool call goes to the next backend, which forces it properly
 * — no outage of the backend.
 */
const forcedChoiceSchema = z.union([
  z.literal("required"),
  z.looseObject({ function: z.looseObject({ name: z.string() }) }),
]);

/**
 * What a forced call is told last, as the model does not force it: the tool
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

const usageSchema = z.looseObject({
  usage: z
    .looseObject({
      completion_tokens: z.number(),
      prompt_cache_hit_tokens: z.number().optional(),
      prompt_cache_miss_tokens: z.number().optional(),
      prompt_tokens: z.number(),
      prompt_tokens_details: z
        .looseObject({ cached_tokens: z.number().optional() })
        .nullish(),
    })
    .nullish(),
});

/**
 * One answer or stream event with `usage.cost` put in roubles (Bro reads it
 * so, `direct.ts`): the tokens priced at the backend's rates and USAGE_USD_RUB.
 * An event without usage stays as it is.
 */
function withCost(json: string, rates: Rates) {
  try {
    const answer = usageSchema.safeParse(JSON.parse(json)).data;
    const usage = answer?.usage;
    if (answer === undefined || usage === undefined || usage === null) {
      return json;
    }
    const cached =
      usage.prompt_cache_hit_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      0;
    const missed =
      usage.prompt_cache_miss_tokens ?? usage.prompt_tokens - cached;
    const dollars =
      (cached * rates.cached +
        missed * rates.input +
        usage.completion_tokens * rates.output) /
      1_000_000;
    return JSON.stringify({
      ...answer,
      usage: { ...usage, cost: dollars * env.USAGE_USD_RUB },
    });
  } catch {
    return json;
  }
}

/** The answer in the form Bro reads, or `undefined` when it failed. */
function readAnswer(text: string, eventStream: boolean, rates: Rates) {
  if (!eventStream) return failed(text) ? undefined : withCost(text, rates);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : undefined;
    if (payload === undefined || payload === "[DONE]" || payload === "") {
      out.push(line);
      continue;
    }
    if (failed(payload)) return undefined;
    out.push(`data: ${withCost(payload, rates)}`);
  }
  return out.join("\n");
}

/** Dollars per million tokens. */
interface Rates {
  readonly cached: number;
  readonly input: number;
  readonly output: number;
}

interface BackendSettings {
  readonly baseUrl: () => string;
  /** The log tag: `[model] <tag> failed`. */
  readonly tag: string;
  readonly forcesTools: boolean;
  readonly key: () => string | undefined;
  readonly models: ReadonlyMap<string, string>;
  readonly name: string;
  readonly rates: Rates;
}

async function askBackend(
  settings: BackendSettings,
  served: { readonly call: ChatCall; readonly model: string },
  init: RequestInit | undefined,
  key: string
) {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("content-type", "application/json");
  const url = `${settings.baseUrl().replace(/\/+$/u, "")}/chat/completions`;
  const note = settings.forcesTools ? undefined : forcedToolNote(served.call);
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
      settings.name
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      // A key over its requests per minute is asked again when the backend
      // says so, not in five minutes.
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
    const text = readAnswer(await response.text(), eventStream, settings.rates);
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
 * A function that sends the chat call to the backend when it serves the
 * model, else (and on any failure of it) to `next`. Without the key the
 * backend is never asked.
 */
export function compatibleBackend(settings: BackendSettings) {
  let downUntil: number | undefined;
  return async function withBackendFirst(
    input: string | URL | Request,
    init: RequestInit | undefined,
    next: () => Promise<Response>
  ): Promise<Response> {
    const key = settings.key();
    const served =
      key === undefined ? undefined : servedCall(input, init, settings.models);
    if (key === undefined || served === undefined) return next();
    if (downUntil !== undefined && Date.now() < downUntil) return next();
    const outcome = await askBackend(settings, served, init, key);
    if (outcome.answer !== undefined) {
      if (downUntil !== undefined) {
        downUntil = undefined;
        console.info(`[model] ${settings.tag} back`);
      }
      return outcome.answer;
    }
    // An answer without the forced tool call is no outage: the next call
    // tries this backend again.
    if (outcome.outage) {
      downUntil = Date.now() + (outcome.retryAfterMs ?? skipForMs);
    }
    console.warn(`[model] ${settings.tag} failed, the next backend answers`, {
      reason: outcome.failure,
    });
    return next();
  };
}
