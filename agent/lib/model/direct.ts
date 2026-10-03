import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  generateId,
  type JSONSchema7,
  type JSONValue,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai";
import type { AgentModelOptionsDefinition } from "eve";
import { z } from "zod";
import { emptyDeliveryMarker } from "@agent/lib/delivery/empty";
import { defuseForgedSkillBlocks } from "@agent/lib/skills/render";
import {
  defuseStepNoteTag,
  taggedStepNote,
} from "@agent/lib/step-context/note";
import { env } from "@shared/environment";
import { modelEndpoint } from "./endpoint";
import { routerAiModelFetch } from "./routerai/fetch";
import { watchedModelFetch } from "./stream-watchdog";

/** The direct backend a selection is built for (`endpoint.ts`). */
type ModelEndpoint = NonNullable<ReturnType<typeof modelEndpoint>>;

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
 * timed out. Modal and Parasail answered a forced tool call with empty `{}`
 * arguments in 3 of 3 tries on 25.09, Phala in 1 of 2, with or without an
 * image; under `auto` they were right, so a forced step there fails.
 * InferenceNet answered a forced `ask_question` with `{}` in 8 of 27 tries
 * on 26.09, whatever the key order (0 of 8 under `auto`), and dropped the
 * required `kind` of a forced `send_message` in 1 of 8.
 */
const brokenHosts = [
  "sail-research",
  "modal",
  "parasail",
  "phala",
  "inference-net",
];

/**
 * RouterAI's own DeepSeek endpoint, which its routing picks first for
 * `deepseek/deepseek-v4.1-flash`, sent nothing but `: PROCESSING` for minutes
 * on 01.10: one call of eight answered, after 901 s. Skipped, the first token
 * came in 1.3–6 s. This holds in code, not only in ROUTERAI_PROVIDER_IGNORE:
 * losing it would hang every turn until the watchdog's ceiling.
 */
const routerAiDeepSeekSkipped = ["deepseek"];

/**
 * RouterAI bills the endpoint that served a call and caches the prompt per
 * endpoint. DeepInfra cached a 55k-token prefix of
 * `deepseek/deepseek-v4.1-flash` whole on every repeat (01.10): a repeated
 * step cost 0.031 ₽ there against 0.071 ₽ on Sail Research and gave each
 * tool call its own id. OpenInference, where routing lands without an order,
 * cached only 533 tokens. Sail Research caches as well but stays in
 * `brokenHosts`: on 01.10 it broke off answer after answer, as on 24.09.
 * A pinned host is never skipped by the lists above; one that fails an
 * answer is skipped for a while (`routerai/hosts.ts`).
 */
const routerAiDeepSeekOrder = ["deepinfra"];

/**
 * The hosts above were measured on DeepSeek only. Another model a workspace
 * picks may be served by one of them alone, and ignoring it there would
 * leave no endpoint at all.
 */
function skippedHosts(modelId: string, endpoint: ModelEndpoint) {
  if (!modelId.startsWith("deepseek/")) return [];
  return [
    ...(endpoint.provider === "routerai" ? routerAiDeepSeekSkipped : []),
    ...keyOrderedHosts,
    ...brokenHosts,
  ];
}

/**
 * `OPENROUTER_PROVIDER_ORDER=baseten,fireworks` (or ROUTERAI_PROVIDER_ORDER)
 * pins the upstream hosts. Left unset, OpenRouter keeps its own sticky
 * routing, which preserves the prompt cache across turns; on RouterAI a
 * DeepSeek model gets the caching hosts above. A DeepSeek model skips the
 * hosts above either way, and ROUTERAI_PROVIDER_IGNORE adds hosts to skip
 * for every model; a pinned host stays pinned.
 */
export function providerRouting(modelId: string, endpoint: ModelEndpoint) {
  const order =
    endpoint.providerOrder ??
    (endpoint.provider === "routerai" && modelId.startsWith("deepseek/")
      ? routerAiDeepSeekOrder
      : []);
  const ignore = [
    ...new Set([
      ...skippedHosts(modelId, endpoint),
      ...endpoint.providerIgnore,
    ]),
  ].filter((slug) => !order.includes(slug));
  if (order.length > 0 && ignore.length > 0) return { ignore, order };
  if (order.length > 0) return { order };
  return ignore.length > 0 ? { ignore } : undefined;
}

/**
 * eve's provider-agnostic `reasoning` effort never reaches OpenRouter: the
 * provider package builds its request body from its own settings and ignores
 * that call option. Reasoning therefore travels as an OpenRouter provider
 * option, which RouterAI reads the same way. The default is low for
 * source-grounded comparison, accepting the extra hidden tokens and latency.
 * Explicit `off` uses `enabled: false`, the only switch the model honors for
 * disabling reasoning (RouterAI still bills hidden reasoning tokens under
 * `include_reasoning: false`).
 */
function reasoningOptions(
  effort: ModelEndpoint["reasoningEffort"]
): AgentModelOptionsDefinition {
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

/** The schema with `change` applied to it and to every schema nested in it. */
function eachSchema(
  schema: JSONSchema7,
  change: (schema: JSONSchema7) => JSONSchema7
): JSONSchema7 {
  const nested = (definition: JSONSchema7Definition): JSONSchema7Definition =>
    definition === true || definition === false
      ? definition
      : eachSchema(definition, change);
  const nestedRecord = (
    definitions: Readonly<Record<string, JSONSchema7Definition>>
  ) =>
    Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => [
        name,
        nested(definition),
      ])
    );
  const result: JSONSchema7 = { ...schema };
  if (schema.properties) result.properties = nestedRecord(schema.properties);
  if (schema.anyOf) result.anyOf = schema.anyOf.map(nested);
  if (schema.oneOf) result.oneOf = schema.oneOf.map(nested);
  if (schema.allOf) result.allOf = schema.allOf.map(nested);
  if (schema.items !== undefined) {
    result.items = Array.isArray(schema.items)
      ? schema.items.map(nested)
      : nested(schema.items);
  }
  if (schema.additionalProperties !== undefined) {
    result.additionalProperties = nested(schema.additionalProperties);
  }
  if (schema.definitions) {
    result.definitions = nestedRecord(schema.definitions);
  }
  return change(result);
}

/**
 * The object with the keys that tell a union's branches apart — a `const`,
 * or an `enum` of one value — first. Hosts that decode a tool call in the
 * order its schema lists keys pick the branch by the first key the model
 * writes: with `id` listed before `kind`, `replyTo: {"kind": "automation",
 * "id": …}` came out as `{"kind": "current"}` on DeepInfra, OpenInference,
 * Alibaba and Wafer (24.09), every time. Only the order changes; what the
 * tool accepts does not.
 */
function discriminatorsFirst(schema: JSONSchema7): JSONSchema7 {
  if (!schema.properties) return schema;
  const properties = Object.entries(schema.properties);
  return {
    ...schema,
    properties: Object.fromEntries([
      ...properties.filter(([, definition]) => fixesValue(definition)),
      ...properties.filter(([, definition]) => !fixesValue(definition)),
    ]),
  };
}

/**
 * Whether a regular expression can match only a whole string: `^` first,
 * an unescaped `$` last, and no `|` outside a group or class that would let
 * one branch match just a part.
 */
function matchesWholeString(pattern: string) {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
  let depth = 0;
  let inClass = false;
  let index = 1;
  while (index < pattern.length - 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (inClass) inClass = char !== "]";
    else if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "|" && depth === 0) return false;
    index += 1;
  }
  return index === pattern.length - 1;
}

/**
 * The string schema without a `pattern` that a host could read differently
 * from JSON Schema. JSON Schema's `pattern` is a search anywhere in the
 * string, but hosts that decode a tool call with a grammar match it against
 * the whole string: `ask_question`'s «contains a non-space» `\S` let
 * DeepInfra, Krea and DigitalOcean write one character, `{"prompt": "I"}`,
 * OpenInference `"I "`, and InferenceNet `{}` (26.09, 3 of 3 tries each
 * with the pattern, none without). eve still checks every call against the
 * tool's own schema, pattern included, and a call that breaks it returns
 * to the model as a tool error, so the rule holds without the host.
 */
function withoutSearchPattern(schema: JSONSchema7): JSONSchema7 {
  if (schema.pattern === undefined || matchesWholeString(schema.pattern)) {
    return schema;
  }
  const { pattern: _searched, ...rest } = schema;
  return rest;
}

function isObjectSchema(definition: JSONSchema7Definition) {
  return (
    definition !== true && definition !== false && definition.type === "object"
  );
}

/**
 * A tool input that is a union of objects, typed as the object it is.
 * StreamLake and GMICloud answer a root with `oneOf` and no `type` with 400
 * «parameters must be a JSON Schema of type object», Novita and NextBit with
 * a bare 400 (25.09, `send_message`), and OpenRouter then retries the step on
 * another host. With the type all four decode it.
 */
function objectRoot(schema: JSONSchema7): JSONSchema7 {
  const branches = schema.oneOf ?? schema.anyOf;
  if (schema.type !== undefined || !branches?.every(isObjectSchema)) {
    return schema;
  }
  return { type: "object", ...schema };
}

/**
 * A tool's input schema as a host should decode it: discriminators first in
 * every object, no pattern it could misread, and a union of objects typed
 * as an object.
 */
function hostSchema(schema: JSONSchema7): JSONSchema7 {
  return objectRoot(
    eachSchema(schema, (node) =>
      discriminatorsFirst(withoutSearchPattern(node))
    )
  );
}

/** Every function tool of a step with its input schema as `hostSchema`. */
function toolSchemaMiddleware(): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      if (!params.tools?.length) return params;
      return {
        ...params,
        tools: params.tools.map((tool) =>
          tool.type === "function"
            ? { ...tool, inputSchema: hostSchema(tool.inputSchema) }
            : tool
        ),
      };
    },
  };
}

/** The tool that reaches the person, which a forced step exists to call. */
const replyToolName = "send_message";

/** A `send_message` branch for a plain message: `kind` fixed to `message`. */
function isMessageBranch(definition: JSONSchema7Definition) {
  if (definition === true || definition === false) return false;
  const kind = definition.properties?.kind;
  return (
    kind !== undefined &&
    kind !== true &&
    kind !== false &&
    kind.const === "message" &&
    definition.properties?.text !== undefined
  );
}

function withTextRequired(schema: JSONSchema7): JSONSchema7 {
  if (!isMessageBranch(schema)) return schema;
  return {
    ...schema,
    required: [...new Set([...(schema.required ?? []), "text"])],
  };
}

function branchWithTextRequired(
  definition: JSONSchema7Definition
): JSONSchema7Definition {
  return definition === true || definition === false
    ? definition
    : withTextRequired(definition);
}

/** `send_message`'s schema with the text of a plain message required. */
function forcedReplySchema(schema: JSONSchema7): JSONSchema7 {
  const result: JSONSchema7 = { ...withTextRequired(schema) };
  if (schema.oneOf) result.oneOf = schema.oneOf.map(branchWithTextRequired);
  if (schema.anyOf) result.anyOf = schema.anyOf.map(branchWithTextRequired);
  return result;
}

/**
 * A forced step's `send_message` with the message's `text` required. Hosts
 * that decode a forced tool call with a grammar (DeepInfra, OpenInference,
 * Krea, AtlasCloud, SiliconFlow on 25.09) keep the schema's key order and let
 * any optional key be skipped: a model that wrote another key where the text
 * belongs could only close the call without it, and did so again at every
 * forced step. Required, the text is the one key the grammar cannot skip.
 * Only what the host decodes changes: the tool still takes an attachment
 * without text, and a step left to the model (`auto`) is not touched.
 */
function forcedReplyTextMiddleware(): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      if (!params.tools?.length) return params;
      return {
        ...params,
        tools: params.tools.map((tool) =>
          tool.type === "function" && tool.name === replyToolName
            ? { ...tool, inputSchema: forcedReplySchema(tool.inputSchema) }
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
 * Keeps only the tools a step is offered. Like `withheldToolsMiddleware`, the
 * history keeps earlier calls of the rest; a call without tools is left alone.
 */
function offeredToolsMiddleware(
  names: readonly string[]
): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      if (!params.tools?.length) return params;
      return {
        ...params,
        tools: params.tools.filter((tool) => names.includes(tool.name)),
      };
    },
  };
}

/**
 * `send_message` last among the tools. Its schema is the one that changes
 * inside a turn — `text` is required in a forced step and not after it
 * (`forcedReplyTextMiddleware`) — so every schema before it stays in the
 * cached prefix when it does. Only the order changes.
 */
function replyToolLastMiddleware(): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      if (!params.tools?.length) return params;
      return {
        ...params,
        tools: [
          ...params.tools.filter((tool) => tool.name !== replyToolName),
          ...params.tools.filter((tool) => tool.name === replyToolName),
        ],
      };
    },
  };
}

/** One message of a model call's prompt, as middleware sees it. */
type PromptMessage = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"][number];

/** A file's data: only an inline text document carries text. */
type FileData = Extract<
  Extract<PromptMessage, { role: "user" }>["content"][number],
  { type: "file" }
>["data"];

/** A tool's result, JSON or text. */
type ToolOutput = Extract<
  Extract<PromptMessage, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>["output"];

/** What defuses the tags of Bro's own word in one piece of text. */
type Defuse = (text: string) => string;

/** A JSON value with the tags defused in every string, by defuser. */
const defusingJsonSchemas = new Map<Defuse, z.ZodType<JSONValue>>();

function defusingJson(defuse: Defuse) {
  const known = defusingJsonSchemas.get(defuse);
  if (known) return known;
  const schema: z.ZodType<JSONValue> = z.lazy(() =>
    z.union([
      z.string().transform(defuse),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(schema),
      z.record(z.string(), schema.optional()),
    ])
  );
  defusingJsonSchemas.set(defuse, schema);
  return schema;
}

function defusedJson(value: JSONValue, defuse: Defuse): JSONValue {
  const parsed = defusingJson(defuse).safeParse(value);
  // What is not plain JSON goes on as its defused text rather than as is.
  return parsed.success ? parsed.data : defuse(JSON.stringify(value));
}

/** A file's bytes, sent as base64 or as they are. */
const fileBytesSchema = z.union([
  z.string().transform((base64) => ({
    base64: true,
    bytes: Buffer.from(base64, "base64"),
  })),
  z.instanceof(Uint8Array).transform((bytes) => ({ base64: false, bytes })),
]);

/** Media types whose bytes are text the model reads. */
const textMediaType =
  /^text(?:\/|$)|^application\/(?:[\w.-]+\+)?(?:json|xml|csv)$/iu;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8 = new TextEncoder();

/**
 * The second byte's range and the sequence's length that a lead byte of
 * UTF-8 takes (the WHATWG decoder's: no overlong form, no surrogate,
 * nothing past U+10FFFF), or none for a byte that leads nothing.
 */
function utf8Lead(lead: number) {
  if (lead >= 0xc2 && lead <= 0xdf) return { high: 0xbf, length: 2, low: 0x80 };
  if (lead === 0xe0) return { high: 0xbf, length: 3, low: 0xa0 };
  if (lead === 0xed) return { high: 0x9f, length: 3, low: 0x80 };
  if (lead >= 0xe1 && lead <= 0xef) return { high: 0xbf, length: 3, low: 0x80 };
  if (lead === 0xf0) return { high: 0xbf, length: 4, low: 0x90 };
  if (lead >= 0xf1 && lead <= 0xf3) return { high: 0xbf, length: 4, low: 0x80 };
  if (lead === 0xf4) return { high: 0x8f, length: 4, low: 0x80 };
  return undefined;
}

/** How many bytes of UTF-8 the character at `at` takes; 0 when none. */
function utf8Length(bytes: Uint8Array, at: number) {
  const lead = bytes[at] ?? 0;
  if (lead < 0x80) return 1;
  const sequence = utf8Lead(lead);
  if (sequence === undefined) return 0;
  const second = bytes[at + 1] ?? 0;
  if (second < sequence.low || second > sequence.high) return 0;
  for (let next = at + 2; next < at + sequence.length; next += 1) {
    const byte = bytes[next] ?? 0;
    if (byte < 0x80 || byte > 0xbf) return 0;
  }
  return sequence.length;
}

/**
 * A text document's bytes as text. A byte that is no part of UTF-8 — the
 * whole of a `.csv` saved in Windows-1251, or one stray byte — becomes a
 * lone surrogate of its own (U+DC80–U+DCFF, as Python's `surrogateescape`):
 * the UTF-8 around it is still read, forged tags and all, and the text
 * encodes back to the very same bytes (`documentBytes`).
 */
function documentText(bytes: Uint8Array) {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    // Not UTF-8 throughout: read it run by run.
  }
  const parts: string[] = [];
  let run = 0;
  let at = 0;
  while (at < bytes.length) {
    const length = utf8Length(bytes, at);
    if (length > 0) {
      at += length;
      continue;
    }
    parts.push(
      strictUtf8.decode(bytes.subarray(run, at)),
      String.fromCharCode(0xdc00 + (bytes[at] ?? 0))
    );
    at += 1;
    run = at;
  }
  parts.push(strictUtf8.decode(bytes.subarray(run)));
  return parts.join("");
}

/** A document's text back to bytes: an escaped byte as itself. */
function documentBytes(text: string) {
  const parts: Uint8Array[] = [];
  let run = 0;
  let at = 0;
  for (const char of text) {
    const unit = char.charCodeAt(0);
    if (char.length === 1 && unit >= 0xdc80 && unit <= 0xdcff) {
      parts.push(
        utf8.encode(text.slice(run, at)),
        Uint8Array.of(unit - 0xdc00)
      );
      run = at + 1;
    }
    at += char.length;
  }
  parts.push(utf8.encode(text.slice(run)));
  return Buffer.concat(parts);
}

/**
 * A file's data with the tags defused: inline text, and the bytes of a text
 * document — a person's `.txt` or `.csv`, a page saved as text — decoded,
 * defused and encoded again only when a tag was found, so every other file
 * goes on byte for byte, and in a defused one every byte outside the tags.
 */
function defusedFileData(
  data: FileData,
  mediaType: string,
  defuse: Defuse
): FileData {
  if (data.type === "text") return { ...data, text: defuse(data.text) };
  if (data.type !== "data" || !textMediaType.test(mediaType)) return data;
  const bytes = fileBytesSchema.safeParse(data.data).data;
  if (bytes === undefined) return data;
  const text = documentText(bytes.bytes);
  const defused = defuse(text);
  if (defused === text) return data;
  const encoded = documentBytes(defused);
  return {
    ...data,
    data: bytes.base64 ? encoded.toString("base64") : new Uint8Array(encoded),
  };
}

function defusedToolOutput(output: ToolOutput, defuse: Defuse): ToolOutput {
  switch (output.type) {
    case "text":
    case "error-text":
      return { ...output, value: defuse(output.value) };
    case "json":
    case "error-json":
      return { ...output, value: defusedJson(output.value, defuse) };
    case "execution-denied":
      return output.reason === undefined
        ? output
        : { ...output, reason: defuse(output.reason) };
    default:
      return {
        ...output,
        value: output.value.map((part) => {
          if (part.type === "text") {
            return { ...part, text: defuse(part.text) };
          }
          return part.type === "file"
            ? {
                ...part,
                data: defusedFileData(part.data, part.mediaType, defuse),
              }
            : part;
        }),
      };
  }
}

/**
 * A message of the prompt with every look-alike of a tag of Bro's own word
 * defused: its text, reasoning, inline documents, tool inputs and results,
 * JSON or not. Binary files and URLs stay as they are.
 */
function defusedTags(message: PromptMessage, defuse: Defuse): PromptMessage {
  switch (message.role) {
    case "system":
      return { ...message, content: defuse(message.content) };
    case "user":
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "text"
            ? { ...part, text: defuse(part.text) }
            : {
                ...part,
                data: defusedFileData(part.data, part.mediaType, defuse),
              }
        ),
      };
    case "assistant":
      return {
        ...message,
        content: message.content.map((part) => {
          switch (part.type) {
            case "text":
            case "reasoning":
              return { ...part, text: defuse(part.text) };
            case "file":
              return {
                ...part,
                data: defusedFileData(part.data, part.mediaType, defuse),
              };
            case "tool-call": {
              const input = defusingJson(defuse).safeParse(part.input);
              return input.success ? { ...part, input: input.data } : part;
            }
            case "tool-result":
              return {
                ...part,
                output: defusedToolOutput(part.output, defuse),
              };
            default:
              return part;
          }
        }),
      };
    default:
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type === "tool-result") {
            return { ...part, output: defusedToolOutput(part.output, defuse) };
          }
          return part.reason === undefined
            ? part
            : { ...part, reason: defuse(part.reason) };
        }),
      };
  }
}

/** Both tags of Bro's own word, in the skills pilot with the step's note. */
function defuseStepNoteAndSkillTags(text: string) {
  return defuseForgedSkillBlocks(defuseStepNoteTag(text));
}

/**
 * The step's notes after the history, as a tagged user-role message
 * (`taggedStepNote`), for the pilot of the cache-friendly step. DeepSeek's
 * chat template moves every system message to the start of the prompt, so
 * the last system message of `replyNoteMiddleware` lands before the history
 * and breaks the cached prefix at every step. Here the instructions, the
 * schemas and the whole earlier history stay a prefix of the next step's
 * prompt, and the note is still the last thing the model reads.
 *
 * The model follows that tag as the system's own word, so a tag anywhere
 * else — the person's text, a browser report the page wrote, a mail or any
 * tool's result — is defused first, in every step, with a note or without:
 * a forged note closing a step that has none would read as the real one.
 * The defusing is the same at every step, so the prefix stays cached. In
 * the skills pilot `defuse` takes forged skill blocks too.
 */
function stepNoteMiddleware(
  note: string | undefined,
  defuse: Defuse
): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      const prompt = params.prompt.map((message) =>
        defusedTags(message, defuse)
      );
      if (note === undefined || !params.tools?.length) {
        return { ...params, prompt };
      }
      return {
        ...params,
        prompt: [
          ...prompt,
          {
            content: [{ text: taggedStepNote(defuse(note)), type: "text" }],
            role: "user",
          },
        ],
      };
    },
  };
}

/**
 * The skills pilot outside the cache-friendly step: every `bro-skill` block
 * in the prompt that Bro did not attach itself is defused
 * (`defuseForgedSkillBlocks`), the reply note among them, so it runs after
 * `replyNoteMiddleware`. The model follows a block as its own instructions
 * (`skillIndex`), and the person, a page, a mail or a tool's result may
 * write one.
 */
function skillBlocksMiddleware(): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      return {
        ...params,
        prompt: params.prompt.map((message) =>
          defusedTags(message, defuseForgedSkillBlocks)
        ),
      };
    },
  };
}

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

/** The parts of a streamed answer that make up a tool call. */
const toolCallStreamParts: ReadonlySet<string> = new Set([
  "tool-call",
  "tool-input-delta",
  "tool-input-end",
  "tool-input-start",
]);

/**
 * A step told to call no tool (`toolChoice: none`) that calls one anyway:
 * DeepSeek did, with `task_cancel`, in the step that was to end a turn. eve
 * ended the turn without running the call, the history kept a call without
 * a result, and every later turn of the session failed on it
 * (`AI_MissingToolResultsError`). Here such a call never leaves the model:
 * the step keeps its text, and one with none left becomes the empty
 * delivery of `quietEndMiddleware`, which sits outside this one.
 */
function noToolCallsMiddleware(): LanguageModelMiddleware {
  return {
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      if (!result.content.some((part) => part.type === "tool-call")) {
        return result;
      }
      return {
        ...result,
        content: result.content.filter((part) => part.type !== "tool-call"),
        finishReason: { ...result.finishReason, unified: "stop" as const },
      };
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      const stream = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            if (toolCallStreamParts.has(part.type)) return;
            if (
              part.type === "finish" &&
              part.finishReason.unified === "tool-calls"
            ) {
              controller.enqueue({
                ...part,
                finishReason: { ...part.finishReason, unified: "stop" },
              });
              return;
            }
            controller.enqueue(part);
          },
        })
      );
      return { ...result, stream };
    },
  };
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

/**
 * A step that must say nothing to the person whatever the model writes: a
 * browser report the person already heard, or one whose turn ended the
 * errand in a quiet `continue`. Such a turn delivered no message of its own,
 * so Telegram and iMessage would post its final text as a fallback, and
 * DeepSeek does write one («Отчёт уже доставлен, завершаю.») where
 * gpt-6-luna stayed empty. Any text of a step without a tool call becomes
 * eve's empty-delivery marker, which ends the turn with `message: null`.
 */
function silentEndMiddleware(): LanguageModelMiddleware {
  return {
    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      if (
        !params.tools?.length ||
        result.content.some((part) => part.type === "tool-call") ||
        result.finishReason.unified === "content-filter"
      ) {
        return result;
      }
      return {
        ...result,
        content: [
          ...result.content.filter((part) => part.type !== "text"),
          { text: emptyDeliveryMarker, type: "text" as const },
        ],
      };
    },
    async wrapStream({ doStream, params }) {
      const result = await doStream();
      if (!params.tools?.length) return result;
      let acted = false;
      const stream = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            if (part.type === "tool-call" || part.type === "tool-input-start") {
              acted = true;
            }
            if (
              part.type === "text-start" ||
              part.type === "text-delta" ||
              part.type === "text-end"
            ) {
              return;
            }
            if (
              part.type === "finish" &&
              !acted &&
              part.finishReason.unified !== "content-filter"
            ) {
              const id = "silent-end";
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

/**
 * The most one step may write. Without `max_tokens` OpenRouter reserves credit
 * for the model's whole output limit, 131,072 tokens for DeepSeek, and answers
 * 402 «requires more credits, or fewer max_tokens» once the balance affords
 * less, though a reply takes one to three thousand: on 26.09 turns failed on
 * their first step at a balance that afforded 24,969. 16,384 holds a long letter
 * or a browser task written out in full. Reasoning tokens count against the
 * same limit, so a thinking step gets twice that.
 */
function maxOutputTokens(endpoint: ModelEndpoint) {
  return (
    endpoint.maxOutputTokens ??
    (endpoint.reasoningEffort === "off" ? 16_384 : 32_768)
  );
}

function outputCapMiddleware(limit: number): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      return {
        ...params,
        maxOutputTokens: Math.min(params.maxOutputTokens ?? limit, limit),
      };
    },
  };
}

/** What the provider package reports a call cost, in the backend's currency. */
const reportedCostSchema = z.object({
  usage: z.object({ cost: z.number().nonnegative() }).loose(),
});

/** A step's provider metadata, as middleware sees it. */
type ProviderMetadata = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>
>["providerMetadata"];

function withGatewayCost(
  metadata: ProviderMetadata,
  toUsd: (cost: number) => number
): ProviderMetadata {
  const reported = reportedCostSchema.safeParse(metadata?.openrouter);
  if (!reported.success) return metadata;
  return {
    ...metadata,
    gateway: { ...metadata?.gateway, cost: toUsd(reported.data.usage.cost) },
  };
}

/**
 * A step's price where eve reads it. eve 0.62 takes a step's `costUsd` only
 * from `providerMetadata.gateway.cost` (`extractGatewayCostUsd` in
 * `eve/dist/src/harness/step-hooks.js`), and the provider package reports it
 * at `providerMetadata.openrouter.usage.cost`, so a direct step reached
 * `usage_costs` unpriced. RouterAI's cost is roubles: it goes to eve as
 * dollars at USAGE_USD_RUB, which `agent/hooks/usage-costs.ts` multiplies
 * back, so the step's roubles are RouterAI's bill; it leaves
 * `usage_costs.cost_usd` empty, as for any price not given in dollars. The
 * dollars in `chats.cost_usd` are at that rate, not at RouterAI's own.
 * A model stream carries its price only on `finish`, which the provider
 * package sends from `flush` even after an error event (`finish-step` is
 * AI SDK's own part, above the middleware); a stream that broke off has none.
 */
function stepCostMiddleware(
  toUsd: (cost: number) => number
): LanguageModelMiddleware {
  return {
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      return {
        ...result,
        providerMetadata: withGatewayCost(result.providerMetadata, toUsd),
      };
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      const stream = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            controller.enqueue(
              part.type === "finish"
                ? {
                    ...part,
                    providerMetadata: withGatewayCost(
                      part.providerMetadata,
                      toUsd
                    ),
                  }
                : part
            );
          },
        })
      );
      return { ...result, stream };
    },
  };
}

/**
 * Sail Research, which served DeepSeek first on RouterAI, numbers a step's tool
 * calls from zero (`call_0`, `call_1`), so every step of a turn reuses the
 * same ids (01.10), and a host RouterAI falls back to may too. eve, AI SDK and the turn's own readers
 * (`agent/lib/delivery/turn-sends.ts`, `claims.ts`, `turn-reads.ts`) pair a
 * result with its call by that id across the whole turn: a `calculate` and
 * the `send_message` after it both were `call_0`, and the reply counted as
 * the calculation. Each call gets an id of its own here, the same for every
 * part of one streamed call.
 */
function uniqueToolCallIdsMiddleware(): LanguageModelMiddleware {
  return {
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      const ids = new Map<string, string>();
      for (const part of result.content) {
        if (part.type === "tool-call" || part.type === "tool-result") {
          part.toolCallId = uniqueCallId(ids, part.toolCallId);
        }
      }
      return result;
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      const ids = new Map<string, string>();
      const stream = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            if (part.type === "tool-call" || part.type === "tool-result") {
              controller.enqueue({
                ...part,
                toolCallId: uniqueCallId(ids, part.toolCallId),
              });
            } else if (
              part.type === "tool-input-start" ||
              part.type === "tool-input-delta" ||
              part.type === "tool-input-end"
            ) {
              controller.enqueue({ ...part, id: uniqueCallId(ids, part.id) });
            } else {
              controller.enqueue(part);
            }
          },
        })
      );
      return { ...result, stream };
    },
  };
}

/** The id one step gives a host's call id, made once per step. */
function uniqueCallId(ids: Map<string, string>, hostId: string) {
  const known = ids.get(hostId);
  if (known !== undefined) return known;
  const id = `call_${generateId()}`;
  ids.set(hostId, id);
  return id;
}

/**
 * eve model selection that calls the direct provider (`endpoint.ts`:
 * RouterAI or OpenRouter) instead of the Gateway.
 */
export function directModelSelection(
  modelId: string,
  options: {
    /**
     * The turn already delivered its reply, so a step that says nothing ends
     * it instead of failing it.
     */
    readonly delivered?: boolean;
    /** The only tools this step may call, when not every tool of the turn. */
    readonly offeredTools?: readonly string[];
    readonly replyNote?: string;
    /** No text of this step may reach the person, empty or not. */
    readonly silent?: boolean;
    /**
     * The skills pilot (`skillsPilot`): `bro-skill` blocks Bro did not
     * attach itself are defused.
     */
    readonly skillBlocks?: boolean;
    /**
     * The pilot of the cache-friendly step (`stepContextPilot`): the note
     * follows the history as a tagged user message, and `send_message` is
     * the last tool.
     */
    readonly stableContext?: boolean;
    readonly toolChoice: StepToolChoice;
    /** Tools this step may not call, though the turn has them. */
    readonly withheldTools?: readonly string[];
  }
) {
  const endpoint = modelEndpoint();
  if (endpoint === undefined) {
    throw new Error("No direct model provider is configured.");
  }
  const routerAi = endpoint.provider === "routerai";
  const provider = createOpenRouter({
    apiKey: endpoint.apiKey,
    baseURL: endpoint.baseURL,
    // A connection that went silent is sent again after 90 s instead of
    // holding the turn for undici's five minutes (`stream-watchdog.ts`);
    // RouterAI's errors are put in the shape the package reads first.
    fetch: routerAi ? routerAiModelFetch : watchedModelFetch,
    headers: endpoint.headers,
  });
  const model = provider.chat(modelId, {
    provider: providerRouting(modelId, endpoint),
  });
  // OpenRouter sends `required` to Anthropic as a forced tool call, which
  // Anthropic rejects while extended thinking is on. `none` is accepted.
  const forcedToolAllowed =
    !modelId.startsWith("anthropic/") || endpoint.reasoningEffort === "off";
  const toolChoice =
    options.toolChoice === "required" && !forcedToolAllowed
      ? "auto"
      : options.toolChoice;

  const withheld = options.withheldTools ?? [];
  const middleware = [
    ...(routerAi ? [stepCostMiddleware((rub) => rub / env.USAGE_USD_RUB)] : []),
    toolSchemaMiddleware(),
    ...(toolChoice === "required" ? [forcedReplyTextMiddleware()] : []),
    ...(withheld.length > 0 ? [withheldToolsMiddleware(withheld)] : []),
    ...(options.offeredTools
      ? [offeredToolsMiddleware(options.offeredTools)]
      : []),
    ...(options.stableContext ? [replyToolLastMiddleware()] : []),
    ...(toolChoice === "auto" ? [] : [toolChoiceMiddleware(toolChoice)]),
    ...(options.stableContext
      ? [
          stepNoteMiddleware(
            options.replyNote,
            options.skillBlocks ? defuseStepNoteAndSkillTags : defuseStepNoteTag
          ),
        ]
      : [
          ...(options.replyNote
            ? [replyNoteMiddleware(options.replyNote)]
            : []),
          ...(options.skillBlocks ? [skillBlocksMiddleware()] : []),
        ]),
    ...(options.silent
      ? [silentEndMiddleware()]
      : options.delivered
        ? [quietEndMiddleware()]
        : []),
    outputCapMiddleware(maxOutputTokens(endpoint)),
    ...(routerAi ? [uniqueToolCallIdsMiddleware()] : []),
    // Innermost: what it drops is never seen by the middleware above.
    ...(toolChoice === "none" ? [noToolCallsMiddleware()] : []),
  ];

  return {
    model: wrapLanguageModel({ middleware, model }),
    // eve resolves an omitted context window from the AI Gateway catalog,
    // which does not list OpenRouter or RouterAI model ids.
    modelContextWindowTokens: endpoint.contextTokens,
    modelOptions: reasoningOptions(endpoint.reasoningEffort),
  };
}
