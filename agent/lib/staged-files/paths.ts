import { z } from "zod";
import type { Prompt } from "@agent/lib/model/prompt";
import { namedAttachmentPaths } from "@agent/lib/sandbox/inbox";
import { currentTurnStart, isStagedPath } from "./prompt";

/**
 * Staged paths a model copied slightly wrong into a tool's input. A model
 * copies a 16-hex hash unreliably (a wrong character, a dropped tail) or
 * writes the person's own Cyrillic name for eve's ASCII one, and the task
 * agent then gets no file. eve's hooks only observe, and the task agent's
 * hook looks a file up by the path written in the message, so the input is
 * mended as the model emits it (`stagedFilesMiddleware` in
 * `agent/lib/model/direct.ts`): eve records, both hooks see and the task
 * agent reads the mended path. A path is only ever mended into one already
 * in the model's prompt, and only when exactly one fits.
 */

const attachmentsRoot = "/workspace/attachments/";
/** A path as a model may write it: up to a space, a quote or a bracket. */
const pathCandidate = /\/workspace\/attachments\/[^\s"'`<>«»()[\]{}]*/gu;
/** Punctuation that ends a sentence, not the path. */
const trailingPunctuation = /[.,;:!?…]+$/u;
const stagedParts = /^\/workspace\/attachments\/([\da-f]{16})\/([\w.-]+)$/u;
/** Shorter hex than this right after the root is no hash. */
const minimumHashChars = 8;
const inputSchema = z.record(z.string(), z.json());

/**
 * The staged paths the prompt's user messages name, its files' and its
 * text's, and those of the current turn.
 */
export function stagedPaths(prompt: Prompt) {
  const cut = currentTurnStart(prompt);
  const known = new Set<string>();
  const current = new Set<string>();
  for (const [index, message] of prompt.entries()) {
    if (message.role !== "user") continue;
    for (const part of message.content) {
      const paths =
        part.type === "file"
          ? isStagedPath(part.filename)
            ? [part.filename]
            : []
          : namedAttachmentPaths(part.text);
      for (const path of paths) {
        known.add(path);
        if (index >= cut) current.add(path);
      }
    }
  }
  return { current: [...current], known: [...known] };
}

function differingChars(a: string, b: string) {
  let differ = 0;
  for (let at = 0; at < a.length; at += 1) {
    if (a[at] !== b[at]) differ += 1;
  }
  return differ;
}

/** The one path of `paths` the miswritten one stands for, if one alone fits. */
function resolved(written: string, paths: readonly string[]) {
  const rest = written.slice(attachmentsRoot.length);
  const hex = (/^[\da-f]+/iu.exec(rest)?.[0] ?? "").toLowerCase();
  const name = rest.split("/").at(-1) ?? "";
  const safeName = name.replace(/[^\w.-]+/gu, "_");
  const hits = paths.filter((path) => {
    const [, hash = "", stagedName = ""] = stagedParts.exec(path) ?? [];
    if (hex.length >= minimumHashChars) {
      if (hex.length < hash.length) return hash.startsWith(hex);
      if (hex.length === hash.length) return differingChars(hex, hash) <= 2;
      return hex.slice(0, hash.length) === hash;
    }
    return name !== "" && stagedName === safeName;
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/** The text with each miswritten path mended, and how many were. */
function repairedText(
  text: string,
  known: readonly string[],
  current: readonly string[]
) {
  let repaired = 0;
  const mended = text.replace(pathCandidate, (match) => {
    const written = match.replace(trailingPunctuation, "");
    if (known.includes(written)) return match;
    const path = resolved(written, known) ?? resolved(written, current);
    if (path === undefined) return match;
    repaired += 1;
    return `${path}${match.slice(written.length)}`;
  });
  return { repaired, text: mended };
}

/** The input's fields, when it is a JSON object. */
function parsedInput(input: string) {
  try {
    return inputSchema.safeParse(JSON.parse(input)).data;
  } catch {
    return undefined;
  }
}

/**
 * A tool call's input with each staged path in its top-level strings that is
 * not one the prompt names mended, when one path alone fits: by its hash
 * (a prefix of 8 hex or more, all 16 within two characters, or more than 16
 * starting with it) or, without one, by its name as eve's staging writes it;
 * first among all the prompt's paths, then this turn's. Anything else, and
 * an input that is not a JSON object, is left as written: the same string
 * when nothing was mended.
 */
export function repairedToolInput(
  input: string,
  known: readonly string[],
  current: readonly string[]
) {
  const fields = parsedInput(input);
  if (fields === undefined) return { input, repaired: 0 };
  let repaired = 0;
  const mended = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      const text = z.string().safeParse(value).data;
      if (text === undefined || !text.includes(attachmentsRoot)) {
        return [key, value];
      }
      const result = repairedText(text, known, current);
      repaired += result.repaired;
      return [key, result.text];
    })
  );
  return repaired === 0
    ? { input, repaired }
    : { input: JSON.stringify(mended), repaired };
}
