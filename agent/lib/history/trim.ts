import { z } from "zod";
import { parsedMetadataHeader } from "@agent/lib/browser-use/outcome";
import {
  browserReportFraming,
  reportedRunLine,
  reportImagesHeading,
} from "@agent/lib/delivery/browser-report";
import type {
  Prompt,
  PromptMessage,
  ToolOutput,
} from "@agent/lib/model/prompt";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import {
  errandInputSchema,
  errandTextSchema,
  type HistoryTrim,
  longErrandChars,
  reportDigest,
} from "./eligible";

/**
 * Tools whose results always go whole: what was said to the person, their
 * answers, the rules the turn follows, memory (`<slot>__<tool>`) and the
 * schedules the person keeps. They are short, and the model acts on them
 * long after their turn.
 */
const keptTools = new Set([
  "ask_question",
  "form_of_address",
  "load_skill",
  "react_to_message",
  "send_message",
  "spend_limit",
  "standing_permission",
]);

function keptWhole(toolName: string) {
  return (
    keptTools.has(toolName) ||
    toolName.includes("__") ||
    toolName.startsWith("schedules-")
  );
}

/** A result this long or shorter costs less than its trace is worth. */
const shortResultChars = 1500;

/** How eve's own compaction marks a result it already cut. */
const eveTruncation = "[Truncated by eve:";

/** How much of a long result the generic trace keeps. */
const genericChars = 1200;

/** How much of each letter's body a thread's trace keeps. */
const letterBodyChars = 280;

/** How much of a run's outcome its result's trace keeps. */
const outcomeChars = 300;

/** How much of a report's own words its trace keeps. */
const reportChars = 600;

/** How much of a long errand an old call keeps. */
const errandChars = 400;

/**
 * The first `length` characters of `text` and `tail`, or the whole text when
 * it is no longer. Never half of a surrogate pair: a lone one is invalid
 * UTF-8 on the wire.
 */
function clip(text: string, length: number, tail = "…") {
  if (text.length <= length) return text;
  const code = text.charCodeAt(length - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? length - 1 : length;
  return `${text.slice(0, end)}${tail}`;
}

/**
 * Tools that only read: calling one again costs a read and changes nothing,
 * so an old result's trace may send the model back to it. `apps` reads too
 * unless its run wrote (`wroteSchema`).
 */
const readingTools = new Set([
  "calculate",
  "calendar-check-availability",
  "calendar-list-events",
  "contacts-search",
  "drive-read",
  "drive-search",
  "find_images",
  "gmail-attachment",
  "gmail-read-thread",
  "gmail-search",
  "list_orders",
  "notion-read",
  "notion-search",
  "route_time",
  "slack-read",
  "slack-search",
  "web_fetch",
  "web_search",
]);

const wroteSchema = z.object({ wrote: z.literal(true) });

/**
 * The sentence every trace ends with. Only a read is worth calling again:
 * a call that sent, booked or wrote must not run twice for the model to see
 * its result.
 */
function shortenedNote(chars: number, toolName: string, output: ToolOutput) {
  const reads =
    readingTools.has(toolName) ||
    (toolName === "apps" && parsedOutput(wroteSchema, output) === undefined);
  return `[Shortened by Bro: an older result of ${String(chars)} characters. ${
    reads
      ? `Call ${toolName} again for the full text.`
      : "This call already ran: do not call it again to see this result."
  }]`;
}

/** A result read by `schema`, whether kept as JSON or as its text. */
function parsedOutput<Schema extends z.ZodType>(
  schema: Schema,
  output: ToolOutput
): z.output<Schema> | undefined {
  if (output.type === "json") return schema.safeParse(output.value).data;
  if (output.type !== "text") return undefined;
  try {
    return schema.safeParse(JSON.parse(output.value)).data;
  } catch {
    return undefined;
  }
}

const field = z.string().nullish();

const letterSchema = z.object({
  attachments: z.array(z.object({ filename: field })).nullish(),
  body: field,
  date: field,
  from: field,
  id: field,
  sentByYou: z.boolean().nullish(),
  subject: field,
  threadId: field,
  to: field,
});

const threadSchema = z.object({
  thread: z.object({ id: field, messages: z.array(letterSchema) }),
});

const searchSchema = z.object({ messages: z.array(letterSchema) });

/** A short top-level value of a JSON result: a status, a flag, an id. */
const scalarSchema = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.null(),
]);

const fieldsSchema = z.record(z.string(), z.unknown());

/**
 * The short top-level values of a JSON object result in key order — whether
 * an `apps` run wrote, how it ended — which a clip of a long result whose
 * payload comes first would cut off. Undefined for any other result.
 */
function scalarFields(output: ToolOutput) {
  const fields = parsedOutput(fieldsSchema, output);
  if (!fields) return undefined;
  const scalars = Object.keys(fields)
    .toSorted()
    .flatMap((key) => {
      const value = scalarSchema.safeParse(fields[key]);
      return value.success ? [[key, value.data] as const] : [];
    });
  return scalars.length > 0
    ? JSON.stringify(Object.fromEntries(scalars))
    : undefined;
}

/** A long result of a tool without a trace of its own: how it opens. */
function genericTrace(serialized: string, output: ToolOutput) {
  const opening = clip(serialized, genericChars);
  const fields = scalarFields(output);
  return fields === undefined ? opening : `${fields}\n${opening}`;
}

const runSchema = z.object({
  outcome: z.string().nullish(),
  runId: z.string(),
  status: z.string(),
});

/** A Gmail thread: who wrote what and when, and how each letter opens. */
function threadTrace(output: ToolOutput) {
  const read = parsedOutput(threadSchema, output);
  if (!read) return undefined;
  return JSON.stringify({
    thread: {
      id: read.thread.id,
      messages: read.thread.messages.map((letter) => ({
        id: letter.id,
        threadId: letter.threadId,
        from: letter.from,
        to: letter.to,
        date: letter.date,
        subject: letter.subject,
        sentByYou: letter.sentByYou,
        attachments: (letter.attachments ?? []).map(
          (attachment) => attachment.filename
        ),
        body: clip(letter.body ?? "", letterBodyChars),
      })),
    },
  });
}

/** A Gmail search: the letters found, without their snippets. */
function searchTrace(output: ToolOutput) {
  const found = parsedOutput(searchSchema, output);
  if (!found) return undefined;
  return JSON.stringify({
    messages: found.messages.map((letter) => ({
      id: letter.id,
      threadId: letter.threadId,
      from: letter.from,
      date: letter.date,
      subject: letter.subject,
    })),
  });
}

/**
 * A web search: each result's title and link (`formatResults` in
 * `agent/tools/web_search.ts`), without snippets and notes.
 */
function webSearchTrace(output: ToolOutput) {
  if (output.type !== "text") return undefined;
  const headings = output.value
    .split("\n\n")
    .filter((block) => /^\d+\. /u.test(block))
    .map((block) => block.split("\n").slice(0, 2).join("\n"));
  return headings.length > 0 ? headings.join("\n\n") : undefined;
}

/**
 * How a run's outcome opens (`browserOutcomeSummary` in
 * `agent/lib/browser-use/outcome.ts`). With the page's report in it the
 * opening is the parsed facts under their untrusted label: the label is the
 * last one, below the page's words, and the page cannot add a later one
 * without the parsed facts still following it. Without the report the
 * outcome opens with those facts.
 */
function outcomeOpening(outcome: string) {
  const at = outcome.lastIndexOf(`${parsedMetadataHeader}\n\n`);
  if (at === -1) return clip(outcome, outcomeChars);
  const facts = outcome.slice(at + parsedMetadataHeader.length + 2);
  return `${parsedMetadataHeader}\n\n${clip(facts, outcomeChars)}`;
}

/** A browser run's answer: its id, status and how its outcome opens. */
function browserTaskTrace(output: ToolOutput) {
  const run = parsedOutput(runSchema, output);
  if (!run) return undefined;
  // JSON leaves out an outcome the run has not got.
  return JSON.stringify({
    outcome: run.outcome ? outcomeOpening(run.outcome) : undefined,
    runId: run.runId,
    shortened: `browser_task status ${run.runId} returns the full outcome`,
    status: run.status,
  });
}

/** The trace of a tool that has one of its own, or undefined. */
function toolTrace(toolName: string, output: ToolOutput) {
  switch (toolName) {
    case "browser_task":
      return browserTaskTrace(output);
    case "gmail-read-thread":
      return threadTrace(output);
    case "gmail-search":
      return searchTrace(output);
    case "web_search":
      return webSearchTrace(output);
    default:
      return undefined;
  }
}

/**
 * An old result as its short trace and the length of what it replaces, or
 * undefined when it goes whole: a kept tool, a failure or refusal, a short
 * result, one eve already cut, or files. The trace is a pure function of the
 * result, so it is the same bytes at every step and the provider's cached
 * prefix holds.
 */
function resultTrace(toolName: string, output: ToolOutput) {
  if (keptWhole(toolName)) return undefined;
  let serialized: string | undefined;
  if (output.type === "text") serialized = output.value;
  if (output.type === "json") serialized = JSON.stringify(output.value);
  if (
    serialized === undefined ||
    serialized.length <= shortResultChars ||
    // eve's compaction cuts a result to text that opens with its marker.
    serialized.startsWith(eveTruncation)
  ) {
    return undefined;
  }
  const trace = toolTrace(toolName, output) ?? genericTrace(serialized, output);
  const text = `${trace}\n\n${shortenedNote(serialized.length, toolName, output)}`;
  return text.length < serialized.length
    ? { chars: serialized.length, text }
    : undefined;
}

/**
 * An old `browser_task` call's input with its long errand cut, the rest as
 * it was, kept as an object or as JSON text the way it came.
 */
function shortenedErrandInput(
  input: Extract<
    Extract<PromptMessage, { role: "assistant" }>["content"][number],
    { type: "tool-call" }
  >["input"]
) {
  const object = errandInputSchema.safeParse(input).data;
  const errand = object ?? errandTextSchema.safeParse(input).data;
  if (errand === undefined || errand.task.length <= longErrandChars) {
    return undefined;
  }
  const shortened = {
    ...errand,
    task: clip(errand.task, errandChars, "…[shortened]"),
  };
  return object ? shortened : JSON.stringify(shortened);
}

/**
 * An old browser report (`browserRunReport` in
 * `agent/lib/browser-use/completion.ts`) as its trace: the marker, the run
 * line, the line framing what follows as untrusted, then the opening of the
 * run's outcome and the images the run saved — the page's words stay below
 * the framing. The errand, the live view and Bro's instructions for that
 * turn are left out: cut short, an instruction could read otherwise.
 * Undefined for a text of another shape.
 */
function reportTrace(text: string) {
  const [marker, runLine, framing] = text.split("\n\n", 3);
  const runId = reportedRunLine.exec(runLine ?? "")?.[1];
  if (
    marker !== backgroundTurnMarker ||
    runId === undefined ||
    // The pattern reads one line of a whole report; here it is the paragraph.
    runLine !== `Browser run ${runId} finished.` ||
    framing !== browserReportFraming
  ) {
    return undefined;
  }
  const head = [marker, runLine, framing].join("\n\n");
  const rest = text.slice(head.length + 2);
  const imagesAt = rest.lastIndexOf(`\n\n${reportImagesHeading}`);
  const images =
    imagesAt === -1 ? undefined : rest.slice(imagesAt + 2).split("\n\n")[0];
  // The outcome ends where the errand begins. A page that writes an errand
  // paragraph of its own only makes the opening shorter.
  const errandAt = rest.indexOf("\n\nErrand: ");
  let end = rest.length;
  if (errandAt !== -1) end = errandAt;
  else if (imagesAt !== -1) end = imagesAt;
  const opening = clip(rest.slice(0, end), reportChars);
  const trace = [
    head,
    opening,
    images,
    `[Shortened by Bro: an older browser report of ${String(text.length)} characters. browser_task status ${runId} or list_orders gives the details.]`,
  ]
    .filter((paragraph) => paragraph !== undefined)
    .join("\n\n");
  return trace.length < text.length ? trace : undefined;
}

/**
 * Whether `key` comes for the first time in a walk through the prompt. The
 * old part of the history opens the prompt's conversation, so the first
 * part with an old id or an old report's text is the old one; a later step
 * that uses the id again, or a report given again, is in the kept turns and
 * goes whole. Deciding by the first part, not by how many there are, keeps
 * the old part's trace the same bytes when such a repeat comes.
 */
function firstSeen(seen: Set<string>, key: string) {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/**
 * The prompt with the old parts `trim` names as their traces. Only the first
 * part with each named id or report changes. System messages, the person's
 * words, memory, assistant text and every part of the kept turns go as they
 * are.
 */
export function trimPrompt(prompt: Prompt, trim: HistoryTrim) {
  const seenResults = new Set<string>();
  const seenCalls = new Set<string>();
  const seenOpeners = new Set<string>();
  // What the prompt lost to the trim, for the log.
  const trimmed = { inputs: 0, openers: 0, results: 0, savedChars: 0 };
  const shortResult = <
    Part extends { output: ToolOutput; toolCallId: string; toolName: string },
  >(
    part: Part
  ): Part => {
    if (
      !firstSeen(seenResults, part.toolCallId) ||
      !trim.results.has(part.toolCallId)
    ) {
      return part;
    }
    const trace = resultTrace(part.toolName, part.output);
    if (trace === undefined) return part;
    trimmed.results += 1;
    trimmed.savedChars += trace.chars - trace.text.length;
    return { ...part, output: { type: "text", value: trace.text } };
  };
  const messages = prompt.map((message): PromptMessage => {
    switch (message.role) {
      case "user":
        return {
          ...message,
          content: message.content.map((part) => {
            if (
              part.type !== "text" ||
              !part.text.startsWith(backgroundTurnMarker)
            ) {
              return part;
            }
            const digest = reportDigest(part.text);
            if (!firstSeen(seenOpeners, digest) || !trim.openers.has(digest)) {
              return part;
            }
            const trace = reportTrace(part.text);
            if (trace === undefined) return part;
            trimmed.openers += 1;
            trimmed.savedChars += part.text.length - trace.length;
            return { ...part, text: trace };
          }),
        };
      case "assistant":
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type === "tool-result") return shortResult(part);
            if (
              part.type !== "tool-call" ||
              !firstSeen(seenCalls, part.toolCallId) ||
              part.toolName !== "browser_task" ||
              !trim.inputs.has(part.toolCallId)
            ) {
              return part;
            }
            const input = shortenedErrandInput(part.input);
            if (input === undefined) return part;
            trimmed.inputs += 1;
            trimmed.savedChars +=
              JSON.stringify(part.input).length - JSON.stringify(input).length;
            return { ...part, input };
          }),
        };
      case "tool":
        return {
          ...message,
          content: message.content.map((part) =>
            part.type === "tool-result" ? shortResult(part) : part
          ),
        };
      default:
        return message;
    }
  });
  return { prompt: messages, trimmed };
}
