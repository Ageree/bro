import { randomUUID } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";
import type { Prompt, PromptMessage, ToolOutput } from "./prompt";

type ToolMessage = Extract<PromptMessage, { role: "tool" }>;
type ToolMessagePart = ToolMessage["content"][number];
type ToolResultPart = Extract<ToolMessagePart, { type: "tool-result" }>;
type ContentPart = Extract<ToolOutput, { type: "content" }>["value"][number];
type UserMessage = Extract<PromptMessage, { role: "user" }>;
type UserFilePart = Extract<UserMessage["content"][number], { type: "file" }>;

/**
 * The pictures of the task agent's `look` (`agent/subagents/task/tools/look.ts`)
 * live here, not in eve's history: a result eve keeps is stored twice and
 * sent again on every later call, and twenty looks of a long job were tens
 * of megabytes of strings in every step. The tool's result carries a marker
 * with the picture's ref; the middleware below puts the picture itself into
 * the prompt. One eve process serves a world (docs/dev-notes.md), so the
 * tool and the model call share this cache; a ref it lost (a restart, the
 * size bound) becomes a line asking the model to look again.
 */
const cacheBytes = 64 * 1024 * 1024;
const cacheTtlMs = 2 * 60 * 60_000;

const looks = new Map<
  string,
  { readonly at: number; readonly data: string; readonly sessionId: string }
>();
let cachedBytes = 0;

/** Drops the oldest pictures while any is too old or the cache too big. */
function evict(now: number) {
  for (const [ref, entry] of looks) {
    if (cachedBytes <= cacheBytes && now - entry.at <= cacheTtlMs) return;
    looks.delete(ref);
    cachedBytes -= entry.data.length;
  }
}

/** Keeps one picture of a session's `look`; the ref goes into its result. */
export function rememberLookImage(sessionId: string, jpegBase64: string) {
  const ref = randomUUID();
  const now = Date.now();
  looks.set(ref, { at: now, data: jpegBase64, sessionId });
  cachedBytes += jpegBase64.length;
  evict(now);
  return ref;
}

function lookImage(ref: string, sessionId: string, now: number) {
  const entry = looks.get(ref);
  if (entry === undefined || entry.sessionId !== sessionId) return undefined;
  return now - entry.at > cacheTtlMs ? undefined : entry.data;
}

/** `[bro-look-image:<ref>|<page>|<encodeURIComponent(path)>]`, as `look` writes it. */
const markerPattern = /^\[bro-look-image:([0-9a-f-]{36})\|(\d+)\|([^\]]*)\]$/u;

/** How many of the latest `look` calls keep their pictures in the prompt. */
const liveLooks = 2;

function decodedPath(encoded: string) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function textPart(text: string): ContentPart {
  return { text, type: "text" };
}

/**
 * A tool result with its pictures taken out into `moved` and a line in
 * their place, or the same part when it has none. A `look` result that is
 * not among the latest two keeps only a line saying what it showed.
 */
function withoutPictures(
  part: ToolResultPart,
  live: boolean,
  moved: UserFilePart[],
  sessionId: string,
  now: number
): ToolResultPart {
  if (part.output.type !== "content") return part;
  let touched = false;
  const parts: ContentPart[] = [];
  for (const item of part.output.value) {
    const marker = item.type === "text" ? markerPattern.exec(item.text) : null;
    if (marker !== null) {
      touched = true;
      const [, ref = "", page = "", encoded = ""] = marker;
      const path = decodedPath(encoded);
      const data = live ? lookImage(ref, sessionId, now) : undefined;
      if (data !== undefined) {
        moved.push({
          data: { data, type: "data" },
          mediaType: "image/jpeg",
          type: "file",
        });
        parts.push(
          textPart(
            `[изображение ${String(moved.length)} — в следующем сообщении]`
          )
        );
      } else if (live) {
        parts.push(
          textPart(
            `[снимок ${path} стр. ${page} — недоступен, вызови look снова]`
          )
        );
      } else {
        parts.push(
          textPart(
            `[снимок ${path} стр. ${page} — уже просмотрен, вызови look снова при необходимости]`
          )
        );
      }
    } else if (item.type === "file" && item.mediaType.startsWith("image/")) {
      touched = true;
      const file: UserFilePart = {
        data: item.data,
        mediaType: item.mediaType,
        type: "file",
      };
      if (item.filename !== undefined) file.filename = item.filename;
      moved.push(file);
      parts.push(
        textPart(
          `[изображение ${String(moved.length)} — в следующем сообщении]`
        )
      );
    } else {
      parts.push(item);
    }
  }
  if (!touched) return part;
  const texts = parts.flatMap((item) =>
    item.type === "text" ? [item.text] : []
  );
  // All text: a plain string, which every host takes in a tool message.
  const output: ToolOutput =
    texts.length === parts.length
      ? { type: "text", value: texts.join("\n") }
      : { type: "content", value: parts };
  return { ...part, output };
}

/**
 * The prompt with tool pictures moved into user messages, or the same
 * prompt when there is none to move.
 */
function movedToolImages(prompt: Prompt, sessionId: string, now: number) {
  const lookResults = prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter(
          (part) =>
            part.type === "tool-result" &&
            part.toolName === "look" &&
            part.output.type === "content"
        )
      : []
  );
  const live = new Set<ToolMessagePart>(lookResults.slice(-liveLooks));
  const out: PromptMessage[] = [];
  let moved: UserFilePart[] = [];
  let changed = false;
  const flush = () => {
    if (moved.length === 0) return;
    out.push({
      content: [
        {
          text: "Изображения из результатов инструментов выше, по порядку.",
          type: "text",
        },
        ...moved,
      ],
      role: "user",
    });
    moved = [];
  };
  for (const message of prompt) {
    if (message.role !== "tool") {
      flush();
      out.push(message);
      continue;
    }
    const content = message.content.map((part) =>
      part.type === "tool-result"
        ? withoutPictures(part, live.has(part), moved, sessionId, now)
        : part
    );
    if (content.some((part, index) => part !== message.content[index])) {
      changed = true;
      out.push({ ...message, content });
    } else {
      out.push(message);
    }
  }
  flush();
  return changed ? out : prompt;
}

/**
 * For the task agent only (`agent/subagents/task/agent.ts`). DeepInfra
 * refuses a picture inside a tool message (422) and takes it in a user
 * message that follows: every picture of a tool result moves into one user
 * message after the tool messages of its step, numbered, with a line in
 * its place. Only the latest two `look` calls keep theirs; older ones are a
 * line naming the file and page. The rewrite lives in the prompt alone and
 * never in eve's history, so readers of the history (`said.ts`,
 * `startsTurn`) never meet that user message — which is why it must never
 * be wired into the main agent: there it would read as the person's own
 * words unless it first carried a kind other than `user`. Without a
 * picture the params come back unchanged, byte for byte.
 */
export function toolImagesMiddleware(options: {
  readonly sessionId: string;
}): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      const prompt = movedToolImages(
        params.prompt,
        options.sessionId,
        Date.now()
      );
      return prompt === params.prompt ? params : { ...params, prompt };
    },
  };
}
