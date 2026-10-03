import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import { z } from "zod";

const taggedMessageSchema = z.object({ kind: z.string() });

function userMessageKind(message: ModelMessage) {
  return taggedMessageSchema.safeParse(message).data?.kind ?? "user";
}

/** Whether a message is eve's compaction marker (`context.compaction`). */
export function compactionMarker(message: ModelMessage) {
  return (
    message.role === "user" && userMessageKind(message) === "context.compaction"
  );
}

/** An assistant message's text as eve reads a summary (`assistantMessageText`). */
function assistantText(message: ModelMessage) {
  if (!Array.isArray(message.content)) return message.content.trim();
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * A digest of the latest summary eve wrote into `messages`: the first
 * assistant message after its last marker. "" for a history without a
 * marker; null for one whose marker no assistant message follows, which
 * tells nothing. eve writes the summary right after its marker
 * (`compactMessages` in `eve/dist/src/harness/compaction.js`), but a step's
 * view of the history may put user messages between them — memory
 * records, client context — so those are skipped. eve's
 * `compaction.completed` does not tell whether it wrote one (`maybeCompact`
 * in `eve/dist/src/harness/tool-loop.js` emits it after only reordering
 * memory records, and after only shortening old tool results, which keeps
 * the summary there was), so a summary is new where the digest changed.
 * eve passes an earlier summary back as trimmed text, and so the digest
 * reads it.
 */
export function summaryDigest(messages: readonly ModelMessage[]) {
  const at = messages.findLastIndex(compactionMarker);
  if (at === -1) return "";
  const summary = messages
    .slice(at + 1)
    .find((message) => message.role !== "user");
  return summary?.role === "assistant" ? digest(assistantText(summary)) : null;
}

/**
 * A digest of a message's text, its parts joined by line breaks: how the
 * record names a turn's opener (`agent/lib/compaction/record.ts`) for a
 * reader of a later history (`agent/lib/browser-use/said.ts`).
 */
export function messageDigest(message: ModelMessage) {
  if (!Array.isArray(message.content)) return digest(message.content);
  return digest(
    message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
  );
}
