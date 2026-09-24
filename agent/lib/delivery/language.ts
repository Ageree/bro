import type { ModelMessage } from "ai";
import { z } from "zod";

/** The languages Bro holds a reply to; any other one is left to the model. */
export type ReplyLanguage = "en" | "ru";

const taggedMessageSchema = z.object({ kind: z.string() });

/**
 * A finished browser run reaches the conversation as a user-role message too
 * (`agent/lib/browser-use/completion.ts`). It is written in English for the
 * model, so it never says which language the person speaks.
 */
const browserRunReportPattern = /^Browser run \S+ finished\./u;

function messageText(message: ModelMessage) {
  if (!Array.isArray(message.content)) return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

const cyrillicLetter = /\p{Script=Cyrillic}/gu;
const latinLetter = /\p{Script=Latin}/gu;
const latinWord = /\p{Script=Latin}{2,}/gu;

/**
 * Letters outside words that carry no language: links, e-mail addresses,
 * `/artifacts/` paths, and bracketed markers such as `[фото]`.
 */
function languageText(text: string) {
  return text
    .replace(/\S+:\/\/\S+|\S+@\S+|\/artifacts\/\S+/gu, " ")
    .replace(/\[[^\]\n]*\]/gu, " ");
}

function letterCounts(text: string) {
  const plain = languageText(text);
  return {
    cyrillic: plain.match(cyrillicLetter)?.length ?? 0,
    latin: plain.match(latinLetter)?.length ?? 0,
    latinWords: plain.match(latinWord)?.length ?? 0,
  };
}

/**
 * The language a person's message is written in, when it clearly is one:
 * any Cyrillic makes it Russian, and English needs two Latin words and no
 * Cyrillic at all. «ok», «👍» or a bare link say nothing.
 */
export function messageLanguage(text: string): ReplyLanguage | undefined {
  const counts = letterCounts(text);
  if (counts.cyrillic > 0 && counts.cyrillic >= counts.latin / 3) return "ru";
  if (counts.cyrillic === 0 && counts.latinWords >= 2) return "en";
  return undefined;
}

/**
 * The language of the latest message the person wrote themselves. Context,
 * memory, background wakeups and browser reports are skipped, and so is a
 * message that names no clear language, so «ok» after an English exchange
 * keeps it English.
 */
export function personLanguage(
  messages: readonly ModelMessage[]
): ReplyLanguage | undefined {
  for (const message of messages.toReversed()) {
    if (message.role !== "user") continue;
    const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
    if (kind !== "user") continue;
    const text = messageText(message);
    if (browserRunReportPattern.test(text)) continue;
    const language = messageLanguage(text);
    if (language) return language;
  }
  return undefined;
}

/**
 * Whether a message Bro is about to send is plainly in the other language.
 * Only a clear case counts: a Russian reply to English is mostly Cyrillic,
 * and an English reply to Russian has several Latin words and no Cyrillic,
 * so names, brands, links and codes never trip it.
 */
export function wrongReplyLanguage(text: string, expected: ReplyLanguage) {
  const counts = letterCounts(text);
  if (expected === "en") {
    return counts.cyrillic >= 12 && counts.cyrillic > counts.latin;
  }
  return counts.cyrillic === 0 && counts.latinWords >= 5;
}

const replyLanguageDirectives = {
  en: "Reply language for this turn: English. The person's latest message is in English, so write every send_message text, question and draft summary in English from the first word. These instructions, stored memory, the profile, workstreams, tool results and earlier messages being in Russian do not change this.",
  ru: "Язык ответа в этом ходе — русский: последнее сообщение человека написано по-русски, поэтому каждый send_message пиши по-русски с первого слова.",
} as const satisfies Record<ReplyLanguage, string>;

/**
 * The note the model reads last on every step. The standing rule sits in the
 * middle of a long Russian prompt, and a small model answering English in
 * Russian ignored it; a short note at the end of the prompt is not buried.
 */
export function replyLanguageDirective(language: ReplyLanguage) {
  return replyLanguageDirectives[language];
}
