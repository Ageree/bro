import { generateId, type LanguageModelMiddleware } from "ai";
import { z } from "zod";

/**
 * DeepSeek writes its tool calls in its own markup, «DSML», which the host
 * serving it turns into the answer's tool calls:
 *
 *   <｜DSML｜function_calls>
 *   <｜DSML｜invoke name="look">
 *   <｜DSML｜parameter name="note" string="true">final check</｜DSML｜parameter>
 *   <｜DSML｜parameter name="paths" string="false">["/workspace/a.png"]</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜function_calls>
 *
 * The bars are full-width (U+FF5C). `string="true"` gives the value as it
 * stands, `string="false"` as JSON. When the model writes the markup a little
 * off — `<｜DSML｜ calls>` with a space and no `function_` on 16.10, or
 * doubled bars as in the browser worker's steps with reasoning on — the host
 * misses it and passes it on as the answer's text. In the task agent that
 * text was the last step's, so it became the helper's report: in the files
 * benchmark of 16.10 Bro got the markup of two `look` calls instead of a
 * report and asked the helper again (`docs/dev-notes.md`). Here a whole
 * block of it becomes the tool calls it names.
 */

/** One or two bars, full-width or not, as the model writes them. */
const bars = "[｜|]{1,2}";

/** A few spaces at most where the model may put them. */
const gap = "\\s{0,3}";

/** The start of a DSML tag: `<｜DSML｜`, or `</｜DSML｜` closing one. */
function dsmlTag(closing: boolean) {
  return `<${closing ? "/" : ""}${gap}${bars}${gap}DSML${gap}${bars}${gap}`;
}

/** What the model calls the block of calls: `function_calls`, or `calls`. */
const callsName = "(?:function_|tool_)?calls";

const openerPattern = new RegExp(`${dsmlTag(false)}${callsName}${gap}>`, "u");

const closerPattern = new RegExp(`${dsmlTag(true)}${callsName}${gap}>`, "u");

/** The same tags, looked for from a place in the text (`lastIndex`) on. */
const openerSearch = new RegExp(openerPattern.source, "gu");
const closerSearch = new RegExp(closerPattern.source, "gu");

/**
 * The longest text `closerPattern` takes: `</｜｜DSML｜｜function_calls>`
 * with three blanks in each gap. A closing tag that a stream's next delta
 * completes starts no further back than this, less one, from the end of
 * what came before.
 */
const longestCloser = 40;

/**
 * More invokes, or parameters, than a block of a real step holds. A block
 * with more stays text: reading each invoke or parameter left open takes a
 * pass over the rest of the block, so a degenerate one would take seconds.
 */
const mostTagsInBlock = 64;

/** The opening tags of invokes and of parameters, to count them. */
const tagOpenerSearches = [
  new RegExp(`${dsmlTag(false)}invoke`, "gu"),
  new RegExp(`${dsmlTag(false)}parameter`, "gu"),
];

const invokePattern = new RegExp(
  `${dsmlTag(false)}invoke\\s+name\\s*=\\s*"([^"]*)"\\s*>([\\s\\S]*?)${dsmlTag(true)}invoke\\s*>`,
  "gu"
);

const parameterPattern = new RegExp(
  `${dsmlTag(false)}parameter\\s+name\\s*=\\s*"([^"]*)"(?:\\s+string\\s*=\\s*"(true|false)")?\\s*>([\\s\\S]*?)${dsmlTag(true)}parameter\\s*>`,
  "gu"
);

/**
 * Text that may grow into a block's opening tag with what comes next: `<`,
 * `<｜DS`, `<｜DSML｜ call`. A stream holds it back until it can tell.
 */
const openerPrefixPattern = new RegExp(
  `^<(?:${gap}(?:${bars}${gap}(?:D(?:S(?:M(?:L${gap}(?:${bars}${gap}[a-z_]{0,16}${gap})?)?)?)?)?)?)?$`,
  "u"
);

/** The longest text `openerPrefixPattern` takes. */
const longestOpenerPrefix = 40;

/** A tool call the markup names: the tool and its input as JSON text. */
interface RecoveredCall {
  readonly input: string;
  readonly toolName: string;
}

/** Why a whole block stayed text. */
type LeftReason = "malformed" | "unknown-tool";

/** A block of DSML calls read: the calls, or why it stays as it is. */
type ReadBlock =
  | { readonly calls: readonly RecoveredCall[]; readonly kind: "calls" }
  | {
      readonly kind: "left";
      readonly reason: LeftReason;
      readonly toolNames: readonly string[];
    };

/** A parameter's value: `string="true"` as it stands, else JSON or the text. */
function parameterValue(value: string, raw: string | undefined) {
  if (raw === "true") return value;
  try {
    return z.json().parse(JSON.parse(value));
  } catch {
    return value;
  }
}

/** Whether nothing but blanks is left of a text once `pattern` is cut out. */
function onlyMatches(text: string, pattern: RegExp) {
  return text.replace(pattern, "").trim() === "";
}

/** Whether a block's body opens more invokes or parameters than a step names. */
function tooManyTags(body: string) {
  return tagOpenerSearches.some((search) => {
    search.lastIndex = 0;
    for (let count = 0; search.exec(body) !== null; count += 1) {
      if (count === mostTagsInBlock) return true;
    }
    return false;
  });
}

/**
 * The calls of one block, between its opening and closing tag. Every invoke
 * must name a tool of the step, and nothing but invokes and their
 * parameters may stand in it; otherwise the block stays text as a whole,
 * and no call of it is made up.
 */
function readBlock(body: string, tools: ReadonlySet<string>): ReadBlock {
  if (tooManyTags(body)) {
    return { kind: "left", reason: "malformed", toolNames: [] };
  }
  const invokes = [...body.matchAll(invokePattern)];
  const toolNames = invokes.map((invoke) => invoke[1] ?? "");
  if (invokes.length === 0 || !onlyMatches(body, invokePattern)) {
    return { kind: "left", reason: "malformed", toolNames };
  }
  if (!toolNames.every((name) => tools.has(name))) {
    return { kind: "left", reason: "unknown-tool", toolNames };
  }
  const calls: RecoveredCall[] = [];
  for (const invoke of invokes) {
    const inner = invoke[2] ?? "";
    if (!onlyMatches(inner, parameterPattern)) {
      return { kind: "left", reason: "malformed", toolNames };
    }
    const input = Object.fromEntries(
      [...inner.matchAll(parameterPattern)].map((parameter) => [
        parameter[1] ?? "",
        parameterValue(parameter[3] ?? "", parameter[2]),
      ])
    );
    calls.push({ input: JSON.stringify(input), toolName: invoke[1] ?? "" });
  }
  return { calls, kind: "calls" };
}

/** A piece of a step's text: text that goes on, or calls in its place. */
type Piece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly calls: readonly RecoveredCall[]; readonly kind: "calls" };

/**
 * Where text at the end of `text`, from `from` on, may still become a
 * block's opening tag.
 */
function openerPrefixAt(text: string, from: number) {
  for (
    let at = Math.max(from, text.length - longestOpenerPrefix);
    at < text.length;
    at += 1
  ) {
    if (text[at] === "<" && openerPrefixPattern.test(text.slice(at))) {
      return at;
    }
  }
  return undefined;
}

/**
 * A step's text cut into what goes on as text and the calls of each whole
 * block, and, unless the text is `whole`, the end held back because a block
 * may be under way in it: an opening tag not yet closed, or what may grow
 * into one. `body` is where an open block's body starts in the held text.
 */
function scanText(text: string, tools: ReadonlySet<string>, whole: boolean) {
  const pieces: Piece[] = [];
  const left: Extract<ReadBlock, { kind: "left" }>[] = [];
  const pass = (from: number, to = text.length) => {
    if (to > from) pieces.push({ kind: "text", text: text.slice(from, to) });
  };
  const done = (held = "", body?: number) => ({ body, held, left, pieces });
  let at = 0;
  for (;;) {
    openerSearch.lastIndex = at;
    const opener = openerSearch.exec(text);
    if (opener === null) {
      const held = whole ? undefined : openerPrefixAt(text, at);
      pass(at, held);
      return done(held === undefined ? "" : text.slice(held));
    }
    const bodyStart = opener.index + opener[0].length;
    closerSearch.lastIndex = bodyStart;
    const closer = closerSearch.exec(text);
    if (closer === null) {
      if (whole) {
        pass(at);
        return done();
      }
      pass(at, opener.index);
      return done(text.slice(opener.index), bodyStart - opener.index);
    }
    const end = closer.index + closer[0].length;
    const block = readBlock(text.slice(bodyStart, closer.index), tools);
    if (block.kind === "calls") {
      pass(at, opener.index);
      pieces.push({ calls: block.calls, kind: "calls" });
    } else {
      left.push(block);
      pass(at, end);
    }
    at = end;
  }
}

/**
 * The end of a streamed text held back: what may still grow into a block's
 * opening tag, or a block opened and not yet closed. An open block keeps
 * its text in the deltas it came in, joined once when it closes or ends,
 * and the end of its body where a closing tag the next delta completes can
 * start, so a long block is read once and not again on every delta.
 */
type Held =
  | { readonly kind: "prefix"; readonly text: string }
  | {
      readonly deltas: string[];
      readonly kind: "open";
      readonly tail: string;
    };

/** How far back a closing tag the next delta completes can start. */
const closerReach = longestCloser - 1;

/** What a scan holds back, kept as `Held`, or none. */
function heldOf({ body, held }: ReturnType<typeof scanText>): Held | undefined {
  if (held === "") return undefined;
  if (body === undefined) return { kind: "prefix", text: held };
  return {
    deltas: [held],
    kind: "open",
    tail: held.slice(Math.max(body, held.length - closerReach)),
  };
}

/** The text held back, whole. */
function heldText(held: Held) {
  return held.kind === "prefix" ? held.text : held.deltas.join("");
}

/** One part of a model's streamed answer, as middleware sees it. */
type StreamPart =
  Awaited<
    ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/** What a model call is asked with, as middleware sees it. */
type CallParams = Parameters<
  NonNullable<LanguageModelMiddleware["wrapGenerate"]>
>[0]["params"];

/**
 * The names of the step's own tools, or none when the step may call none:
 * `toolChoice: none` is `noToolCallsMiddleware`'s step, which drops calls.
 */
function callableTools(params: CallParams) {
  if (params.toolChoice?.type === "none") return undefined;
  const names = (params.tools ?? []).flatMap((tool) =>
    tool.type === "function" ? [tool.name] : []
  );
  return names.length > 0 ? new Set(names) : undefined;
}

/** A model's whole answer, as middleware sees it. */
type GeneratedAnswer = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>
>;

/** What a model's whole answer holds. */
type Content = GeneratedAnswer["content"];

/**
 * The finish reason of a step that got calls from its text: `tool-calls`
 * where the step ended on its own, and as it was where it was cut short or
 * failed (`length`, `content-filter`, `error`), which the caller must see.
 */
function finishedWithCalls(
  reason: GeneratedAnswer["finishReason"]
): GeneratedAnswer["finishReason"] {
  return reason.unified === "stop" || reason.unified === "other"
    ? { ...reason, unified: "tool-calls" }
    : reason;
}

/** The text parts of a whole answer, read only to look for a block in them. */
const answerTextsSchema = z.object({
  content: z.array(
    z.looseObject({ text: z.string().optional(), type: z.string() })
  ),
});

/**
 * Whether a text part of a whole answer opens a block. An answer that does
 * not read as one — a test's model that answers nothing — goes on as it is.
 */
function opensBlock(answer: GeneratedAnswer) {
  return (answerTextsSchema.safeParse(answer).data?.content ?? []).some(
    (part) => part.type === "text" && openerPattern.test(part.text ?? "")
  );
}

function toolCallPart(call: RecoveredCall) {
  return {
    input: call.input,
    toolCallId: `call_${generateId()}`,
    toolName: call.toolName,
    type: "tool-call" as const,
  };
}

function logScan(scan: ReturnType<typeof scanText>) {
  const recovered = scan.pieces.flatMap((piece) =>
    piece.kind === "calls" ? piece.calls.map((call) => call.toolName) : []
  );
  if (recovered.length > 0) {
    console.warn("[model] DSML markup in the text became tool calls", {
      toolNames: recovered,
    });
  }
  for (const block of scan.left) {
    console.warn("[model] DSML markup in the text left as it is", {
      reason: block.reason,
      toolNames: block.toolNames,
    });
  }
  return recovered.length > 0;
}

/**
 * A step whose text holds a whole block of DSML calls gets those calls as
 * its own, the block cut out of the text and `tool-calls` as its finish
 * reason unless it was cut short, when every call of the block names a tool
 * of the step. A stream
 * holds text back only from where a block may start until it can tell, so
 * plain text goes on as it comes, and a step whose text never writes `<`
 * before a bar passes on part by part as it was.
 */
export function dsmlToolCallsMiddleware(): LanguageModelMiddleware {
  return {
    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      const tools = callableTools(params);
      if (tools === undefined || !opensBlock(result)) return result;
      let recovered = 0;
      const content = result.content.flatMap((part): Content => {
        if (part.type !== "text") return [part];
        const scan = scanText(part.text, tools, true);
        if (!logScan(scan)) return [part];
        recovered += 1;
        return scan.pieces.flatMap((piece): Content => {
          if (piece.kind === "calls") return piece.calls.map(toolCallPart);
          return piece.text.trim() === ""
            ? []
            : [{ ...part, text: piece.text }];
        });
      });
      if (recovered === 0) return result;
      return {
        ...result,
        content,
        finishReason: finishedWithCalls(result.finishReason),
      };
    },
    async wrapStream({ doStream, params }) {
      const result = await doStream();
      const tools = callableTools(params);
      if (tools === undefined) return result;
      const heldTexts = new Map<string, Held>();
      let recovered = false;
      /**
       * The text of `id` read on: its pieces passed on, the end where a
       * block may be under way held back unless it is `whole`. A delta that
       * comes out as it went in goes on as the very part it was.
       */
      const passOn = (
        controller: TransformStreamDefaultController<StreamPart>,
        id: string,
        text: string,
        whole: boolean,
        delta?: StreamPart
      ) => {
        const scan = scanText(text, tools, whole);
        if (logScan(scan)) recovered = true;
        const held = heldOf(scan);
        if (held === undefined) heldTexts.delete(id);
        else heldTexts.set(id, held);
        if (
          delta !== undefined &&
          scan.held === "" &&
          scan.pieces.length === 1 &&
          scan.pieces.every(
            (piece) => piece.kind === "text" && piece.text === text
          )
        ) {
          controller.enqueue(delta);
          return;
        }
        for (const piece of scan.pieces) {
          if (piece.kind === "text") {
            controller.enqueue({ delta: piece.text, id, type: "text-delta" });
          } else {
            for (const call of piece.calls) {
              controller.enqueue(toolCallPart(call));
            }
          }
        }
      };
      /**
       * A delta of `id` read on. While a block is open, only the end of its
       * body and the delta are looked at: the text is read whole again only
       * once a closing tag ends in the delta.
       */
      const passDelta = (
        controller: TransformStreamDefaultController<StreamPart>,
        part: Extract<StreamPart, { type: "text-delta" }>
      ) => {
        const held = heldTexts.get(part.id);
        if (held === undefined) {
          if (part.delta.includes("<")) {
            passOn(controller, part.id, part.delta, false, part);
          } else {
            controller.enqueue(part);
          }
          return;
        }
        if (held.kind === "prefix") {
          passOn(controller, part.id, held.text + part.delta, false);
          return;
        }
        const end = held.tail + part.delta;
        if (closerPattern.test(end)) {
          passOn(controller, part.id, heldText(held) + part.delta, false);
          return;
        }
        held.deltas.push(part.delta);
        heldTexts.set(part.id, { ...held, tail: end.slice(-closerReach) });
      };
      const passHeld = (
        controller: TransformStreamDefaultController<StreamPart>,
        id?: string
      ) => {
        // A whole text is never held again: each entry goes as it is read.
        for (const [heldId, held] of heldTexts) {
          if (id === undefined || id === heldId) {
            passOn(controller, heldId, heldText(held), true);
          }
        }
      };
      const stream = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          flush(controller) {
            passHeld(controller);
          },
          transform(part, controller) {
            switch (part.type) {
              case "text-delta":
                passDelta(controller, part);
                return;
              case "text-end":
                passHeld(controller, part.id);
                controller.enqueue(part);
                return;
              // The text before a call the host itself made goes first.
              case "tool-input-start":
              case "tool-call":
                passHeld(controller);
                controller.enqueue(part);
                return;
              case "finish":
                passHeld(controller);
                controller.enqueue(
                  recovered
                    ? {
                        ...part,
                        finishReason: finishedWithCalls(part.finishReason),
                      }
                    : part
                );
                return;
              default:
                controller.enqueue(part);
            }
          },
        })
      );
      return { ...result, stream };
    },
  };
}
