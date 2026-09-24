import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  type JSONSchema7,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai";
import type { AgentModelOptionsDefinition } from "eve";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";

const applicationName = "Bro";

/**
 * OpenRouter attributes traffic on its dashboard from these headers, and the
 * provider package only sets its own `X-OpenRouter-Title` variant.
 */
function attributionHeaders() {
  return {
    "HTTP-Referer": applicationOrigin(),
    "X-Title": applicationName,
  };
}

/**
 * Hosts that make a tool call list its keys exactly in schema order. A union
 * then turns on key order rather than meaning, and an optional key the model
 * writes later than the schema lists it is lost. On 24.09
 * `deepseek/deepseek-v4.1-flash` behind them turned `schedules-create`
 * «15 января 2099» into a daily reminder and «каждое 5-е число» or
 * «последний день месяца» into a first or last weekday of the month (4 of 9
 * calls on Alibaba, 2 of 3 on Wafer, 2 of 8 on Morph); every other host of
 * the model got all of them right. Putting discriminators first
 * (`discriminatorsFirst`) fixes the unions, not the lost keys.
 */
const keyOrderedHosts = ["alibaba", "morph", "wafer"];

/**
 * Sail Research broke `deepseek/deepseek-v4.1-flash` tool calls on 24.09:
 * «invalid or incomplete DSML tool-call block» and «reasoning marker while
 * reasoning was disabled», 36 failed calls in one eval run, whose turns then
 * timed out.
 */
const brokenHosts = ["sail-research"];

const skippedHosts = [...keyOrderedHosts, ...brokenHosts];

/**
 * `OPENROUTER_PROVIDER_ORDER=baseten,fireworks` pins the upstream hosts. Left
 * unset, OpenRouter keeps its own sticky routing, which preserves the prompt
 * cache across turns. Either way the hosts above are skipped.
 */
function providerRouting() {
  const order = env.OPENROUTER_PROVIDER_ORDER?.split(",")
    .map((slug) => slug.trim().toLowerCase())
    .filter((slug) => slug.length > 0);
  return order && order.length > 0
    ? { ignore: skippedHosts, order }
    : { ignore: skippedHosts };
}

/**
 * eve's provider-agnostic `reasoning` effort never reaches OpenRouter: the
 * provider package builds its request body from its own settings and ignores
 * that call option. Reasoning therefore travels as an OpenRouter provider
 * option, and stays off by default because DeepSeek still spends roughly 1,600
 * hidden tokens before the first visible character at the lowest effort.
 * `enabled: false` is the only switch the model honors.
 */
function reasoningOptions(): AgentModelOptionsDefinition {
  const effort = env.OPENROUTER_REASONING_EFFORT;
  if (effort === "off") {
    return {
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
    };
  }
  return { providerOptions: { openrouter: { reasoning: { effort } } } };
}

/**
 * How a step may use its tools: `required` must call one, `none` may only
 * write text, which ends the turn, and `auto` leaves it to the model.
 */
export type StepToolChoice = "auto" | "none" | "required";

/**
 * eve exposes no tool choice option, so a model call that must or must not
 * pick a tool gets it from middleware. A call without tools, such as
 * compaction, is left alone because `required` with nothing to call is an
 * invalid request.
 */
function toolChoiceMiddleware(
  type: Exclude<StepToolChoice, "auto">
): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      if (!params.tools?.length) return params;
      return { ...params, toolChoice: { type } };
    },
  };
}

/** A schema, or `true`/`false` for one that takes anything or nothing. */
type JSONSchema7Definition = JSONSchema7 | boolean;

/** Whether a schema allows one value only, as a union's discriminator does. */
function fixesValue(definition: JSONSchema7Definition) {
  return (
    definition !== true &&
    definition !== false &&
    (definition.const !== undefined || definition.enum?.length === 1)
  );
}

function reordered(definition: JSONSchema7Definition): JSONSchema7Definition {
  return definition === true || definition === false
    ? definition
    : discriminatorsFirst(definition);
}

function reorderedRecord(
  definitions: Readonly<Record<string, JSONSchema7Definition>>
) {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      reordered(definition),
    ])
  );
}

/**
 * The same schema with the keys that tell a union's branches apart — a
 * `const`, or an `enum` of one value — first in every object. Hosts that
 * decode a tool call in the order its schema lists keys pick the branch by
 * the first key the model writes: with `id` listed before `kind`,
 * `replyTo: {"kind": "automation", "id": …}` came out as `{"kind":
 * "current"}` on DeepInfra, OpenInference, Alibaba and Wafer (24.09), every
 * time. Only the order changes; what the tool accepts does not.
 */
function discriminatorsFirst(schema: JSONSchema7): JSONSchema7 {
  const result: JSONSchema7 = { ...schema };
  if (schema.properties) {
    const properties = Object.entries(reorderedRecord(schema.properties));
    result.properties = Object.fromEntries([
      ...properties.filter(([, definition]) => fixesValue(definition)),
      ...properties.filter(([, definition]) => !fixesValue(definition)),
    ]);
  }
  if (schema.anyOf) result.anyOf = schema.anyOf.map(reordered);
  if (schema.oneOf) result.oneOf = schema.oneOf.map(reordered);
  if (schema.allOf) result.allOf = schema.allOf.map(reordered);
  if (schema.items !== undefined) {
    result.items = Array.isArray(schema.items)
      ? schema.items.map(reordered)
      : reordered(schema.items);
  }
  if (schema.additionalProperties !== undefined) {
    result.additionalProperties = reordered(schema.additionalProperties);
  }
  if (schema.definitions) {
    result.definitions = reorderedRecord(schema.definitions);
  }
  return result;
}

/** Every function tool of a step, its input schema discriminators first. */
function discriminatorsFirstMiddleware(): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      if (!params.tools?.length) return params;
      return {
        ...params,
        tools: params.tools.map((tool) =>
          tool.type === "function"
            ? { ...tool, inputSchema: discriminatorsFirst(tool.inputSchema) }
            : tool
        ),
      };
    },
  };
}

/**
 * Takes tools out of one step's offer. The history keeps its earlier calls
 * of them; the model just cannot make another. A call without tools, such as
 * compaction, is left alone.
 */
function withheldToolsMiddleware(
  names: readonly string[]
): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      if (!params.tools?.length) return params;
      return {
        ...params,
        tools: params.tools.filter((tool) => !names.includes(tool.name)),
      };
    },
  };
}

/**
 * Appends the reply note (language, Bro's voice, how to address the person,
 * `agent/lib/delivery/language.ts`) as the last system message of the prompt.
 * At the end it does not break the cached prefix, and it is the freshest thing
 * the model reads before it writes. A call without tools, such as compaction,
 * writes nothing to the person and is left alone.
 */
function replyNoteMiddleware(note: string): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      if (!params.tools?.length) return params;
      return {
        ...params,
        prompt: [...params.prompt, { content: note, role: "system" }],
      };
    },
  };
}

/**
 * eve's own marker for a step that deliberately says nothing: a final text
 * equal to it ends the turn with `message: null` instead of a reply
 * (`eve/dist/src/shared/empty-delivery.js`, not exported).
 */
const emptyDeliveryMarker = "<eve-empty-delivery/>";

/** One part of a model's streamed answer, as middleware sees it. */
type StreamPart =
  Awaited<
    ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/** What a model's whole answer holds, as middleware sees it. */
type GeneratedContent = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>
>["content"];

/**
 * Whether a step produced nothing eve can keep: no visible text and no tool
 * call. Reasoning alone is still an empty response to eve.
 */
function saidNothing(content: GeneratedContent) {
  return !content.some(
    (part) =>
      part.type === "tool-call" ||
      (part.type === "text" && part.text.trim().length > 0)
  );
}

/**
 * Once a turn's reply reached the person, a model with nothing more to say
 * may answer with no text and no tool call at all: `openai/gpt-6-luna` did
 * it after almost every delivery, whether `toolChoice` was `auto` or `none`
 * (`deepseek/deepseek-v4.1-flash` writes a short closing line instead).
 * eve treats that as a broken model call, re-asks once with «answer now from
 * the tool results» and then fails the turn (`MODEL_CALL_FAILED`, «The model
 * did not return a response»), so a delivered answer ended in a failed turn
 * and Telegram posted «что-то сломалось» under it. Here such a step becomes
 * eve's empty-delivery marker, which ends the turn cleanly and delivers
 * nothing. A step that did write text or call a tool is passed as it is.
 */
function quietEndMiddleware(): LanguageModelMiddleware {
  return {
    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      if (!params.tools?.length || !saidNothing(result.content)) return result;
      if (result.finishReason.unified === "content-filter") return result;
      return {
        ...result,
        content: [
          ...result.content,
          { text: emptyDeliveryMarker, type: "text" as const },
        ],
      };
    },
    async wrapStream({ doStream, params }) {
      const result = await doStream();
      if (!params.tools?.length) return result;
      let spoke = false;
      const stream = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            if (
              part.type === "tool-call" ||
              part.type === "tool-input-start" ||
              (part.type === "text-delta" && part.delta.trim().length > 0)
            ) {
              spoke = true;
            }
            if (
              part.type === "finish" &&
              !spoke &&
              part.finishReason.unified !== "content-filter"
            ) {
              const id = "quiet-end";
              controller.enqueue({ id, type: "text-start" });
              controller.enqueue({
                delta: emptyDeliveryMarker,
                id,
                type: "text-delta",
              });
              controller.enqueue({ id, type: "text-end" });
            }
            controller.enqueue(part);
          },
        })
      );
      return { ...result, stream };
    },
  };
}

/** eve model selection that calls OpenRouter directly instead of the Gateway. */
export function openRouterSelection(
  modelId: string,
  options: {
    /**
     * The turn already delivered its reply, so a step that says nothing ends
     * it instead of failing it.
     */
    readonly delivered?: boolean;
    readonly replyNote?: string;
    readonly toolChoice: StepToolChoice;
    /** Tools this step may not call, though the turn has them. */
    readonly withheldTools?: readonly string[];
  }
) {
  const openrouter = createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
    headers: attributionHeaders(),
  });
  const model = openrouter.chat(modelId, { provider: providerRouting() });
  // OpenRouter sends `required` to Anthropic as a forced tool call, which
  // Anthropic rejects while extended thinking is on. `none` is accepted.
  const forcedToolAllowed =
    !modelId.startsWith("anthropic/") ||
    env.OPENROUTER_REASONING_EFFORT === "off";
  const toolChoice =
    options.toolChoice === "required" && !forcedToolAllowed
      ? "auto"
      : options.toolChoice;

  const withheld = options.withheldTools ?? [];
  const middleware = [
    discriminatorsFirstMiddleware(),
    ...(withheld.length > 0 ? [withheldToolsMiddleware(withheld)] : []),
    ...(toolChoice === "auto" ? [] : [toolChoiceMiddleware(toolChoice)]),
    ...(options.replyNote ? [replyNoteMiddleware(options.replyNote)] : []),
    ...(options.delivered ? [quietEndMiddleware()] : []),
  ];

  return {
    model: wrapLanguageModel({ middleware, model }),
    // eve resolves an omitted context window from the AI Gateway catalog,
    // which does not list OpenRouter model ids.
    modelContextWindowTokens: env.OPENROUTER_MODEL_CONTEXT_TOKENS,
    modelOptions: reasoningOptions(),
  };
}
