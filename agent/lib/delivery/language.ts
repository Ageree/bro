import type { ModelMessage } from "ai";
import { z } from "zod";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import type { FormOfAddress } from "@shared/chat/form-of-address";

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
 * memory, background wakeups, browser reports and scheduled or proactive
 * reports (English prompts Bro writes to itself) are skipped, and so is a
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
    if (browserRunReportPattern.test(text) || isBackgroundTurnText(text)) {
      continue;
    }
    const language = messageLanguage(text);
    if (language) return language;
  }
  return undefined;
}

const replyLanguageDirectives = {
  en: "Reply language for this turn: English. The person's latest message is in English, so write your own words in every send_message in English from the first word. These instructions, stored memory, the profile, workstreams, tool results and earlier messages being in Russian do not change this. Text the person asked for in another language (a translation, a letter or post to write in Russian) stays in that language.",
  ru: "Язык ответа в этом ходе — русский: последнее сообщение человека написано по-русски, поэтому свои слова в каждом send_message пиши по-русски с первого слова. Текст, который человек попросил на другом языке (перевод, письмо или пост по-английски), остаётся на том языке.",
} as const satisfies Record<ReplyLanguage, string>;

/**
 * Bro is «бро», and a small model writing Russian slipped into the feminine
 * («сделаю сама», «я готова») whatever the long prompt said.
 */
const masculineVoice =
  "О себе пиши в мужском роде: «сделал», «нашёл», «готов», «сам», «уверен», а не «сделала», «нашла», «готова», «сама», «уверена».";

function russianAddress({ formal, name }: FormOfAddress) {
  return [
    formal
      ? "Человек просил обращаться к нему на «вы»: «вы», «вам», «ваш», «посмотрите», «хотите» — в каждом сообщении, без «ты», пока он сам не попросит снова на «ты»."
      : "К человеку обращайся на «ты», если он не просил обращаться к нему на «вы».",
    ...(name
      ? [`Обращайся к человеку по имени «${name}», как он просил.`]
      : []),
  ];
}

/**
 * The voice is Bro's own: a letter, a post or a message written for the
 * person or on their behalf keeps the gender and address that text needs.
 */
const ownWordsOnly =
  "Это про твои собственные слова человеку; письма и тексты, которые пишешь от его имени или для других людей, пиши в нужном им роде и обращении.";

/**
 * The note comes after everything else in the prompt, so once the reply went
 * out it sits right after its tool result and reads like a fresh request or a
 * remark on what was just sent. In the 24.09 benchmark the model answered it
 * six times in one turn — «перешёл на «вы»» after a note that says the
 * person asked for «вы» — and opened another with «Прошу прощения,
 * поправлюсь». After a delivery the note says it is neither.
 */
const answeredNotes = {
  en: "Your reply to the person's latest message has already been delivered in this turn. This note is not a new message and not a remark on what you sent: do not answer it, repeat, restate or correct what was sent. It only sets the style of a further message, which you send only with something new; otherwise end the turn without calling any tool.",
  ru: "Ответ на последнее сообщение человека в этом ходе уже доставлен. Эта пометка — не новое сообщение и не замечание к отправленному: не отвечай на неё, не повторяй, не пересказывай и не поправляй отправленное. Она лишь задаёт стиль следующего сообщения, а его шли, только если есть что-то новое; иначе закончи ход без вызова инструментов.",
} as const satisfies Record<ReplyLanguage, string>;

/**
 * The note the model reads last on every step that may write to the person.
 * Standing rules sit in the middle of a long Russian prompt, and a small
 * model ignored them: it answered English in Russian, spoke of itself in
 * the feminine, and went back to «ты» in a new chat after the person asked
 * for «вы». A short note at the end of the prompt is not buried.
 *
 * `language` is the person's latest clear language; without one (a bare
 * «ok», a scheduled report) the Russian voice rules still hold for whatever
 * the model writes in Russian. It is guidance, never a filter on sends: a
 * translation or a text the person asked for in another language is exactly
 * what they want.
 */
export function replyDirective({
  answered = false,
  formOfAddress,
  language,
}: {
  /** Whether this turn already delivered a message to the person. */
  readonly answered?: boolean;
  readonly formOfAddress: FormOfAddress;
  readonly language: ReplyLanguage | undefined;
}) {
  if (language === "en") {
    return [
      ...(answered ? [answeredNotes.en] : []),
      replyLanguageDirectives.en,
      ...(formOfAddress.name
        ? [`Call the person «${formOfAddress.name}», as they asked.`]
        : []),
    ].join(" ");
  }
  const voice = [
    masculineVoice,
    ...russianAddress(formOfAddress),
    ownWordsOnly,
  ];
  return [
    ...(answered ? [answeredNotes.ru] : []),
    ...(language === "ru"
      ? [replyLanguageDirectives.ru]
      : ["Когда пишешь человеку по-русски:"]),
    ...voice,
  ].join(" ");
}

/**
 * The form of address the person chose, for the turn's instructions: a
 * Gateway model id carries no per-step note, so without this it would never
 * learn the choice. Nothing when they never chose.
 */
export function chosenFormOfAddress(formOfAddress: FormOfAddress) {
  if (!formOfAddress.formal && !formOfAddress.name) return undefined;
  return russianAddress(formOfAddress).join(" ");
}

/**
 * What `form_of_address` answers once the choice is saved. The turn's
 * instructions were resolved before it, and a Gateway model gets no per-step
 * note, so the tool result is where the rest of the turn learns the new form.
 */
export function savedFormOfAddressNote(formOfAddress: FormOfAddress) {
  return `Saved. From this reply on, this replaces anything said earlier in this turn about how to address the person: ${russianAddress(formOfAddress).join(" ")}`;
}
