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

/** A message the person wrote, not one Bro opened a turn with. */
function isPersonMessage(message: ModelMessage) {
  if (message.role !== "user") return false;
  const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
  return kind === "user" && !isBackgroundTurnText(messageText(message));
}

/**
 * The person's messages that end at `opening`: it, and any they sent right
 * before it with nothing of Bro's between — «739204» and a second later
 * «это код», which eve steers into one turn. Null when Bro opened the turn.
 *
 * A reply of Bro's or a tool result stops the walk: eve's history has no turn
 * id, but a turn Bro answered always leaves one, so an earlier turn's code or
 * «можно дороже» never reaches a later «ну что там?».
 */
function personBurst(messages: readonly ModelMessage[], opening: number) {
  const message = messages[opening];
  if (message === undefined || !isPersonMessage(message)) return null;
  const before = messages.slice(0, opening);
  const stop = before.findLastIndex(
    (earlier) =>
      earlier.role !== "user" ||
      (startsTurn(earlier) && !isPersonMessage(earlier))
  );
  return [...before.slice(stop + 1), message]
    .filter((said) => startsTurn(said) && isPersonMessage(said))
    .map((said) => messageText(said));
}

/**
 * What the person wrote in this turn. `said`: the messages they opened it
 * with, null when Bro opened it — a browser report, a scheduled result, a
 * wakeup, whose text a page or a worker wrote. `answers`: what they answered
 * to its questions, in either kind of turn. A follow-up acts on these words
 * only; only a turn they opened is theirs for consent.
 */
export function personWordsThisTurn(messages: readonly ModelMessage[]) {
  const opening = messages.findLastIndex(startsTurn);
  return {
    answers: opening === -1 ? [] : answersThisTurn(messages.slice(opening + 1)),
    said: personBurst(messages, opening),
  };
}

/** A word that makes a number next to it a one-time code: «SMS», "OTP". */
const codeContextPattern =
  /(?<!\p{L})(?:смс|sms|otp|одноразов\p{L}*|one[\s-]time|verification)(?!\p{L})/iu;

/**
 * «код 739204», «код подтверждения: 4821», "code is 7392" — a word for a code
 * right before the number, which no other reading of it overrides;
 * «промокод 1234», «код домофона 4567» or «код для входа 4567» is not a
 * one-time code.
 */
const codeLeadPattern =
  /(?<!\p{L})(?:код\p{L}*|code\p{L}*|пароль\p{L}*|password|пин|pin)(?:\s+(?:подтверждения|для|по|из|с|от|к|смс|sms|сообщения|письма|почты|сайта|банка|is|from|for|the))*[\s:—–-]*$/iu;

/**
 * «СМС 739204», «SMS: 739204», «OTP 739204» — right before the number, where
 * a capitalised prefix would otherwise read it as a flight or an order; an
 * amount after it («по SMS 1500 руб») stays an amount.
 */
const messageLeadPattern = /(?<!\p{L})(?:смс|sms|otp)[\s:—–-]*$/iu;

/**
 * A word for a code that names the number through an order, a flight or a
 * sender, with only such connecting words between: «код подтверждения
 * заказа 739204», «код от ВТБ 739204», «код, пришедший для заказа 739204».
 * Any other word breaks it: «код не пришёл — оформи заказ 48213», «не жди
 * SMS-код и оформи заказ 48213» name no code.
 */
const codeNamesNumberPattern =
  /(?<!\p{L})(?:[Кк]од|КОД|[Cc]ode|[Пп]арол|[Pp]assword|[Пп]ин|PIN|[Pp]in|SMS|[Ss]ms|СМС|[Сс]мс|OTP|[Oo]tp)\p{Ll}*(?:(?:\s*,\s*|\s+|-)(?:подтверждения|для|по|из|с|от|к|на|смс|sms|SMS|СМС|сообщения|письма|почты|сайта|банка|брони|бронирования|оплаты|заказа|заказу|заказ|рейса|рейсу|рейс|поезда|поезд|order|flight|train|for|from|пришедш\p{Ll}*|присланн\p{Ll}*|полученн\p{Ll}*|отправленн\p{Ll}*|\p{Lu}[\p{L}\d]*))*\s*[№#]?\s*$/u;

/**
 * A code right after the number, which makes the number its label: «заказ
 * 48213: 739204», «рейс SU 1234 — 739204».
 */
const codeAfterPattern = /^\s*[:—–-]\s*\d(?:[  -]?\d){3,7}(?!\d)/u;

/** How far from the number a word like «SMS» still describes it. */
const codeContextReach = 25;

/**
 * A run of four to eight digits, as people copy a code out of a message —
 * «739204», «739 204», «73-92-04», «Код: 739204.» — and not part of a longer
 * number, a date, a time or a decimal: punctuation counts as part of the
 * number only with a digit on its far side.
 */
const digitGroupPattern = /(?<!\d|\d[.,:])\d(?:[  -]?\d){3,7}(?!\d|[.,:]\d)/gu;

/** A currency after a number: «4 890 ₽», «1500 руб», «15 %». */
const currencyAfterPattern =
  /^\s*(?:₽|\$|€|%|руб\p{L}*|р\.|р(?!\p{L})|rub|usd|eur|тыс\p{L}*)/iu;

/** Any other unit after a number: «2 шт», «2026 год», «5 минут». */
const unitAfterPattern =
  /^\s*(?:шт|км|мин(?:ут[аыу]?)?\.?(?!\p{L})|год(?:а|у|ом)?(?!\p{L})|лет(?!\p{L})|г\.|г(?!\p{L}))/iu;

/**
 * What names a number as something other than a code: a currency sign, or
 * a flight or order prefix («SU 1234», «S7 1234», «№ 1234»).
 */
const namedBeforePattern =
  /(?:[₽$€]|(?<!\p{L})(?:\p{Lu}[\p{Lu}\d]{0,2}|№|#))[\s-]?$/u;

/** A month before a year: «15 октября 2026». */
const monthBeforePattern =
  /(?<!\p{L})(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*\s+$/iu;

/** A word naming the number: «рейс su 1234», «поезд 7412», «заказ 48213». */
const idWordBeforePattern =
  /(?<!\p{L})(?:рейс|поезд|заказ|order|flight|train)\p{L}*(?:\s+[\p{L}\d]{1,3})?\s*$/iu;

/** A date written as digits: «2026-10-15», «15-10-2026». */
const numericDatePattern = /^(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})$/u;

/** Whether the number is plainly an amount or a date, whatever names it. */
function amountOrDate(number: string, before: string, after: string) {
  return (
    numericDatePattern.test(number) ||
    currencyAfterPattern.test(after) ||
    monthBeforePattern.test(before)
  );
}

/** Whether an order, a flight or a prefix names the number. */
function idBefore(before: string) {
  return namedBeforePattern.test(before) || idWordBeforePattern.test(before);
}

/** A word that names a postal index: «индекс 119192», «почтовый индекс:». */
const postalLabelPattern =
  /(?<!\p{L})(?:(?:почтов\p{L}*\s+)?индекс\p{L}*|index|post\s*code|postal\s+code|zip(?:\s*code)?)\s*[:№]?\s*$/iu;

/**
 * A part of an address: a street, a house, a city, a region, or the word
 * «адрес» itself. An abbreviation counts only with its full stop: a bare
 * «к» or «д» is a preposition as often as a building.
 */
const addressWordPattern =
  /(?<!\p{L})(?:улиц\p{L}*|проспект\p{L}*|переул\p{L}*|шоссе|бульвар\p{L}*|набережн\p{L}*|площад\p{L}*|проезд\p{L}*|аллея|тупик|дом|корпус\p{L}*|строени\p{L}*|квартир\p{L}*|город\p{L}*|област\p{L}*|район\p{L}*|посел\p{L}*|пос[её]л\p{L}*|село|деревн\p{L}*|микрорайон\p{L}*|адрес\p{L}*|москв\p{L}*|петербург\p{L}*|росси\p{L}*|street|avenue|road)(?!\p{L})|(?<!\p{L})(?:ул|просп|пр|пер|наб|пл|д|корп|стр|кв|г|обл|пос|мкр|st|ave|rd)\.|(?<!\p{L})(?:б-р|р-н|пр-т)(?!\p{L})/iu;

/** A word for a code close before the number: «код», «SMS», «пароль». */
const codeWordPattern =
  /(?<!\p{L})(?:код\p{L}*|code|смс|sms|otp|парол\p{L}*|password)(?!\p{L})/iu;

/** How far an address may reach from a postal index to its other parts. */
const addressReach = 80;

/**
 * A Russian postal index among the parts of an address — «…к адресу
 * Мичуринский проспект, 1, Москва, 119192», «119192, Москва, ул. …» — or
 * after the word «индекс». On 25.09 (RU d04) a follow-up that named the
 * pickup point by the person's address was refused as carrying the code
 * «119192», and the model lost a step taking the address out. Six solid
 * digits only, and never with a word for a code right before them.
 */
function postalIndex(number: string, before: string, after: string) {
  if (!/^\d{6}$/u.test(number)) return false;
  if (postalLabelPattern.test(before)) return true;
  if (codeWordPattern.test(before.slice(-codeContextReach))) return false;
  const parts = [
    /,\s*$/u.test(before) ? before.slice(-addressReach) : undefined,
    /^\s*,/u.test(after) ? after.slice(0, addressReach) : undefined,
  ];
  return parts.some(
    (part) => part !== undefined && addressWordPattern.test(part)
  );
}

/** Whether the number at this place is plainly an amount, a date or an id. */
function namedOtherwise(number: string, before: string, after: string) {
  if (amountOrDate(number, before, after) || unitAfterPattern.test(after)) {
    return true;
  }
  // «код подтверждения заказа 739204»: a word for the code naming the number
  // wins over the order or flight word right before it.
  if (codeNamesNumberPattern.test(before)) return false;
  return idBefore(before) || postalIndex(number, before, after);
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
 * — any such group that is not plainly an amount, a date or an id. An order
 * or a flight number followed by the code («заказ 48213: 739204») is the
 * code's label, not a code.
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
    if (idBefore(before) && codeAfterPattern.test(after)) return [];
    const near = [
      before.slice(-codeContextReach),
      after.slice(0, codeContextReach),
    ];
    const isCode =
      codeLeadPattern.test(before) ||
      (messageLeadPattern.test(before) &&
        !amountOrDate(match[0], before, after)) ||
      (!namedOtherwise(match[0], before, after) &&
        (options.awaitingCode ||
          near.some((words) => codeContextPattern.test(words))));
    return isCode ? [match[0].replaceAll(/\D/gu, "")] : [];
  });
}

/** The codes among `codes` that the person did not write themselves. */
export function codesNotFromPerson(
  codes: readonly string[],
  personWords: readonly string[]
) {
  const written = new Set(personWords.flatMap(digitGroups));
  return [...new Set(codes)].filter((code) => !written.has(code));
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

/**
 * Whether the quote is the person's own words, from this turn's message. A
 * message with no words at all — «👍», «+» — is quoted whole.
 */
export function quotedFromPerson(
  quote: string,
  personWords: readonly string[]
) {
  const said = comparable(quote);
  if (said.length === 0) {
    const whole = quote.trim();
    return (
      whole.length > 0 && personWords.some((words) => words.trim() === whole)
    );
  }
  return personWords.some((words) =>
    ` ${comparable(words)} `.includes(` ${said} `)
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
