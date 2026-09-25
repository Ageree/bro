import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import { startsTurn } from "@agent/lib/delivery/turn-sends";

const taggedMessageSchema = z.object({ kind: z.string() });

function messageText(message: ModelMessage) {
  if (!Array.isArray(message.content)) return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/** eve's `ask_question` result once the person answered it. */
const answerSchema = z.object({
  optionId: z.string().optional(),
  status: z.literal("answered"),
  text: z.string().optional(),
});

const questionSchema = z.object({
  options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
});

function answerOf(output: ToolResultPart["output"]) {
  if (output.type === "json") return answerSchema.safeParse(output.value).data;
  if (output.type !== "text") return undefined;
  try {
    return answerSchema.safeParse(JSON.parse(output.value)).data;
  } catch {
    return undefined;
  }
}

/**
 * The person's answers to `ask_question` in this turn: what they typed, and
 * the label of the option they picked. An answer resumes the same turn as a
 * tool result, not as a message of theirs.
 */
function answersThisTurn(messages: readonly ModelMessage[]) {
  const labels = new Map<string, ReadonlyMap<string, string>>();
  const answers: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.toolName !== "ask_question") {
          continue;
        }
        const options = questionSchema.safeParse(part.input).data?.options;
        labels.set(
          part.toolCallId,
          new Map((options ?? []).map((option) => [option.id, option.label]))
        );
      }
    }
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "ask_question") {
        continue;
      }
      const answer = answerOf(part.output);
      if (answer?.text !== undefined) answers.push(answer.text);
      const label =
        answer?.optionId === undefined
          ? undefined
          : labels.get(part.toolCallId)?.get(answer.optionId);
      if (label !== undefined) answers.push(label);
    }
  }
  return answers;
}

/**
 * What the person wrote in this turn: their latest message and their answers
 * to questions asked after it. Null when that latest message is Bro's own —
 * a browser report, a scheduled result, a wakeup, whose text a page or a
 * worker wrote — which the person joins only by answering its approval card.
 * A follow-up acts on these words only.
 *
 * Only the latest message: eve's history has no turn id, and the messages
 * before it cannot be told apart from an earlier turn's — luna's delivered
 * turns keep no closing step (`<eve-empty-delivery/>`), a failed model call
 * leaves the person's message last. Walking back handed an old code or an
 * earlier «можно дороже» to a later «ну что там?». A code the person sent
 * just before a second message is asked for again instead.
 */
export function personWordsThisTurn(messages: readonly ModelMessage[]) {
  const opening = messages.findLastIndex(startsTurn);
  const message = opening === -1 ? undefined : messages[opening];
  if (message?.role !== "user") return null;
  const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
  if (kind !== "user") return null;
  const text = messageText(message);
  if (isBackgroundTurnText(text)) return null;
  return [text, ...answersThisTurn(messages.slice(opening + 1))];
}

/** A word that makes a number next to it a one-time code: «SMS», "OTP". */
const codeContextPattern =
  /(?<!\p{L})(?:смс|sms|otp|одноразов\p{L}*|one[\s-]time|verification)(?!\p{L})/iu;

/**
 * «код 739204», «код подтверждения: 4821», «СМС 739204», "code is 7392" — a
 * word for a code right before the number, which no other reading of it
 * overrides; «промокод 1234» or «код домофона 4567» is not a one-time code.
 */
const codeLeadPattern =
  /(?<!\p{L})(?:код\p{L}*|code\p{L}*|пароль\p{L}*|password|пин|pin|смс|sms|otp)(?:\s+(?:подтверждения|из|с|от|смс|sms|сообщения|письма|почты|сайта|банка|is|from|the))*[\s:—–-]*$/iu;

/** How far from the number a word like «SMS» still describes it. */
const codeContextReach = 25;

/**
 * A run of four to eight digits, as people copy a code out of a message —
 * «739204», «739 204», «73-92-04», «Код: 739204.» — and not part of a longer
 * number, a date, a time or a decimal: punctuation counts as part of the
 * number only with a digit on its far side.
 */
const digitGroupPattern =
  /(?<!\d|\d[.,:])\d(?:[ \u00a0-]?\d){3,7}(?!\d|[.,:]\d)/gu;

/** A unit or a currency after a number: «4 890 ₽», «2026 год», «15 %». */
const unitAfterPattern =
  /^\s*(?:₽|\$|€|%|руб\p{L}*|р\.|р(?!\p{L})|rub|usd|eur|тыс\p{L}*|шт|км|мин\p{L}*|год\p{L}*|г\.|г(?!\p{L}))/iu;

/**
 * What names a number as something other than a code: a currency sign, or
 * a flight or order prefix («SU 1234», «S7 1234», «№ 1234»).
 */
const namedBeforePattern =
  /(?:[₽$€]|(?<!\p{L})(?:\p{Lu}[\p{Lu}\d]{0,2}|№|#))[\s-]?$/u;

/**
 * A month before a year («15 октября 2026»), or a word naming the number:
 * «рейс su 1234», «поезд 7412», «номер заказа 48213».
 */
const wordBeforePattern =
  /(?<!\p{L})(?:(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*|(?:рейс|поезд|заказ|order|flight|train)\p{L}*(?:\s+[\p{L}\d]{1,3})?)\s*$/iu;

/** A date written as digits: «2026-10-15», «15-10-2026». */
const numericDatePattern = /^(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})$/u;

/** Whether the number at this place is plainly an amount, a date or an id. */
function namedOtherwise(number: string, before: string, after: string) {
  return (
    numericDatePattern.test(number) ||
    unitAfterPattern.test(after) ||
    namedBeforePattern.test(before) ||
    wordBeforePattern.test(before)
  );
}

function digitGroups(text: string) {
  return [...text.matchAll(digitGroupPattern)].map((match) =>
    match[0].replaceAll(/\D/gu, "")
  );
}

/**
 * The one-time codes a text carries: a four-to-eight digit group a word for
 * a code leads, or one a word like «SMS» stands next to, or — when the run
 * may be waiting for a code, where a bare number is how a code is passed on
 * — any such group that is not plainly an amount, a year or an id.
 */
export function oneTimeCodesIn(
  text: string,
  options: { readonly awaitingCode: boolean }
) {
  return [...text.matchAll(digitGroupPattern)].flatMap((match) => {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const near = [
      before.slice(-codeContextReach),
      after.slice(0, codeContextReach),
    ];
    const isCode =
      codeLeadPattern.test(before) ||
      (!namedOtherwise(match[0], before, after) &&
        (options.awaitingCode ||
          near.some((words) => codeContextPattern.test(words))));
    return isCode ? [match[0].replaceAll(/\D/gu, "")] : [];
  });
}

/** Whether every code in `codes` is one the person wrote themselves. */
export function codesFromPerson(
  codes: readonly string[],
  personWords: readonly string[]
) {
  const written = new Set(personWords.flatMap(digitGroups));
  return codes.every((code) => written.has(code));
}

/** Text compared word for word: case, «ё», spacing and punctuation aside. */
function comparable(text: string) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether the quote is the person's own words, from this turn's message. */
export function quotedFromPerson(
  quote: string,
  personWords: readonly string[]
) {
  const said = comparable(quote);
  return (
    said.length > 0 &&
    personWords.some((words) => ` ${comparable(words)} `.includes(` ${said} `))
  );
}

/**
 * A message that only asks how things stand — «ну что там?», «как дела с
 * билетами?», «есть новости?» — and gives the errand nothing new.
 */
const statusQuestionPattern =
  /^(?:(?:ну|и|а|так|бро)\s+)*(?:(?:что|как)(?:\s+(?:там|тут|дела|успехи|оно|продвигается|идет|получилось|по\s+\p{L}+|с\s+\p{L}+(?:\s+\p{L}+)?))*|есть\s+(?:новости|что\s+нибудь|результат)|новости|статус|ну|и|any\s+news|any\s+update|whats\s+up|what\s+s\s+up|status|update|so|well|how\s+is\s+it\s+going|how\s+s\s+it\s+going)(?:\s+(?:там|уже|бро))*$/u;

/**
 * «Готово» is how a person says they confirmed a sign-in or a payment in
 * their app, the reply Bro asks for; only «готово?» asks how things stand.
 */
const readyPattern =
  /^(?:(?:ну|и|а|так|бро)\s+)*готово(?:\s+(?:там|уже|бро))*$/u;

/** Whether the words only ask how the errand stands. */
export function onlyAsksHowItStands(words: string) {
  const said = comparable(words);
  if (said.length === 0) return false;
  if (readyPattern.test(said)) return /[?？]\s*$/u.test(words);
  return statusQuestionPattern.test(said);
}
