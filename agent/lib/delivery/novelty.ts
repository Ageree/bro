/**
 * How messages one turn sends are compared: whether a later one repeats an
 * earlier one, and whether it tells the person anything the earlier ones did
 * not. A model that keeps talking after its answer went out rarely repeats
 * itself word for word: it rephrases the same status — «пока смотрю», «как
 * только страница отдаст данные — пришлю» — so only the facts a message
 * carries say whether it is news.
 */

export function normalizedText(text: string) {
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  const words = lower.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // A message of only emoji or punctuation is compared as written.
  return words || lower.replace(/\s+/gu, " ").trim();
}

function bigrams(text: string) {
  const counts = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Sørensen–Dice similarity of two texts over character bigrams, 0 to 1. */
export function similarity(left: string, right: string) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  let shared = 0;
  for (const [pair, count] of leftPairs) {
    shared += Math.min(count, rightPairs.get(pair) ?? 0);
  }
  return (2 * shared) / (left.length - 1 + (right.length - 1));
}

/**
 * «1 085,95 ₽» and «20 000» are one number each, not two: the space between
 * digit groups is a thousands separator.
 */
function joinedThousands(text: string) {
  return text.replace(/(?<=\d)[ \u00A0\u202F](?=\d{3}(?!\d))/gu, "");
}

/**
 * Numbers, dates, times, codes, and links exactly as written, before any
 * normalization: two messages from one template, such as the outbound and the
 * return flight, or payment links that differ only in punctuation, differ in
 * these, so they are never repeats of each other.
 */
export function codesOf(text: string) {
  const tokens = joinedThousands(text.normalize("NFKC"))
    .split(/\s+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}/]+|[^\p{L}\p{N}/]+$/gu, ""))
    .filter(
      (token) =>
        /\p{N}/u.test(token) ||
        // Identifier-shaped codes such as `order_ab` or `abc-def`.
        /[\p{L}\p{N}][-_][\p{L}\p{N}]/u.test(token) ||
        token.includes("://") ||
        token.includes("/artifacts/")
    );
  return [...new Set(tokens)].toSorted();
}

/**
 * Every capitalized word, the first one of a sentence included, so «Анна
 * придёт» and «Мария придёт» stay different messages.
 */
export function namesOf(text: string) {
  const words = text.normalize("NFKC").match(/\p{Lu}[\p{L}\p{M}]*/gu) ?? [];
  return [...new Set(words.map((word) => word.toLocaleLowerCase()))].toSorted();
}

/**
 * Capitalized words inside a sentence: a place, a shop, a person, a flight.
 * A capital after a full stop, a colon or a line break only opens the
 * sentence, and «Прошу прощения» or «Коротко:» is no news.
 */
export function properNamesOf(text: string) {
  const names = text
    .normalize("NFKC")
    .matchAll(/(?<=[\p{L}\p{N},)»"—–-]\s+[«"(]?)\p{Lu}[\p{L}\p{M}]*/gu);
  return [
    ...new Set([...names].map(([name]) => name.toLocaleLowerCase())),
  ].toSorted();
}

function sentencesOf(text: string) {
  return text
    .normalize("NFKC")
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((sentence) =>
      sentence.replace(/[\s»"')\]\p{Extended_Pictographic}]+$/gu, "")
    );
}

/** The questions a message asks, one normalized sentence each. */
export function questionsOf(text: string) {
  return sentencesOf(text)
    .filter((sentence) => sentence.endsWith("?"))
    .map(normalizedText)
    .filter((question) => question.length > 0);
}

/**
 * Verbs that ask the person to hand something over or decide: a code, a
 * confirmation in their bank app, a choice — «пришли код», «подтвердите
 * вход», «send me the code».
 */
const requestVerbs =
  /(?<!\p{L})(?:пришли|пришлите|скинь|скиньте|отправь|отправьте|продиктуй|продиктуйте|подтверди|подтвердите|одобри|одобрите|введи|введите|выбери|выберите|назови|назовите|ответь|ответьте|send me|confirm|approve|enter|choose|pick|reply)(?!\p{L})/iu;

/**
 * Asking to be told, which a condition turns into a courtesy: «напиши, если
 * что» asks for nothing.
 */
const tellVerbs =
  /(?<!\p{L})(?:напиши|напишите|скажи|скажите|дай знать|дайте знать|tell me|let me know)(?!\p{L})/iu;

const condition = /(?<!\p{L})(?:если|if)(?!\p{L})/iu;

/**
 * What a message asks the person to do or hand over, one normalized sentence
 * each: a request without a question mark is still something only they can
 * answer.
 */
export function requestsOf(text: string) {
  return sentencesOf(text)
    .filter(
      (sentence) =>
        requestVerbs.test(sentence) ||
        (tellVerbs.test(sentence) && !condition.test(sentence))
    )
    .map(normalizedText)
    .filter((request) => request.length > 0);
}

/**
 * A message the turn delivered, as later sends are compared with it: `text`
 * is its normalized words, the rest are the facts that make a message news.
 * It rides in the durable closure of `send_message`, so it stays plain JSON.
 */
export interface SentMessage {
  readonly attachments: readonly string[];
  readonly codes: readonly string[];
  readonly names: readonly string[];
  readonly properNames: readonly string[];
  readonly questions: readonly string[];
  readonly requests: readonly string[];
  readonly text: string;
}

/**
 * Whether each name of one message also occurs as a word of the other. A
 * sentence opener that only changed case, «Готово! Напомню» after «Готово,
 * напомню», still occurs; a different person or place does not.
 */
export function namesShared(message: SentMessage, other: SentMessage) {
  const words = new Set(other.text.split(" "));
  return message.names.every((name) => words.has(name));
}

/** Two texts at least this similar say the same thing. */
export const nearDuplicateSimilarity = 0.9;

/** A question this close to one already asked is the same question. */
const sameQuestionSimilarity = 0.6;

/**
 * A number, a link, an artifact, an order or ticket code — not a hyphenated
 * word such as «туда-обратно», which every paraphrase may carry.
 */
function isFact(code: string) {
  return (
    /\p{N}/u.test(code) ||
    code.includes("://") ||
    code.includes("/artifacts/") ||
    code.includes("_") ||
    /^[\p{Script=Latin}-]+$/u.test(code)
  );
}

const plainNumber = /^\d+(?:[.,]\d+)?$/u;

/**
 * «около 1 086 ₽» after «1 085,95 ₽» is the same sum, rounded; a different
 * seat, question or option number is not, so only sums of a hundred and more
 * get the leeway.
 */
function sameFact(code: string, known: string) {
  if (code === known) return true;
  if (!plainNumber.test(code) || !plainNumber.test(known)) return false;
  const value = Number(code.replace(",", "."));
  const knownValue = Number(known.replace(",", "."));
  const larger = Math.max(Math.abs(value), Math.abs(knownValue));
  return larger >= 100 && Math.abs(value - knownValue) <= larger * 0.02;
}

/**
 * Words of a message that only says the work goes on and the result will
 * follow. After other work, a message still passes when it reports what that
 * work found; it is held back only when it is this kind of status.
 */
const statusWords =
  /(?:^| )(?:пока|смотрю|ищу|проверяю|продолжаю|жду|ждём|ждем|как только|как будет|как придёт|как придет|пришлю|напишу|отпишусь|сообщу|скину|в работе|работает|в процессе|still|as soon as|will send|will let you know|working on|keep you posted)(?= |$)/u;

/**
 * Words of a message that puts its answer off: the result is to come in a
 * later message — «пришлю», «напишу, как только…», «as soon as».
 */
const laterWords =
  /(?:^| )(?:пришлю|напишу|отпишусь|сообщу|скину|дам знать|вернусь|как только|as soon as|will send|will let you know|get back to you|keep you posted)(?= |$)/u;

/**
 * Words of a short line that only says the work is under way: «смотрю
 * почту», «секунду, проверю». In a longer message they may describe what Bro
 * does in general («ищу билеты, бронирую столики»), so they count only in a
 * line this short.
 */
const busyWords =
  /(?:^| )(?:смотрю|ищу|проверяю|уточняю|выясняю|разбираюсь|собираю|секунду|минутку|сейчас (?:посмотрю|проверю|найду|поищу|узнаю|гляну|уточню|соберу|сделаю)|looking|checking|searching|one moment|one sec)(?= |$)/u;

const busyLineLength = 80;

/**
 * Whether a message announces work instead of reporting it: it says Bro is
 * on it, or that the answer will come later.
 */
export function announcesWork(message: SentMessage) {
  return (
    laterWords.test(message.text) ||
    (message.text.length <= busyLineLength && busyWords.test(message.text))
  );
}

function isLink(code: string) {
  return code.includes("://") || code.includes("/artifacts/");
}

/** Whether some of `asks` is not close to anything in `asked`. */
function asksAnew(asks: readonly string[], asked: readonly string[]) {
  return asks.some(
    (ask) =>
      !asked.some((known) => similarity(ask, known) >= sameQuestionSimilarity)
  );
}

/**
 * Whether a message puts something to the person that the delivered ones did
 * not: a picture, a link, a question, or a request — a code, a confirmation,
 * a choice. What a browser run found is told once; a message that only says
 * it again, adds a detail or corrects itself is the same result a second
 * time.
 */
export function asksOrShowsNew(
  message: SentMessage,
  delivered: readonly SentMessage[]
) {
  const attachments = new Set(delivered.flatMap((sent) => sent.attachments));
  if (message.attachments.some((attachment) => !attachments.has(attachment))) {
    return true;
  }
  const links = new Set(
    delivered.flatMap((sent) => sent.codes.filter((code) => isLink(code)))
  );
  if (message.codes.some((code) => isLink(code) && !links.has(code))) {
    return true;
  }
  const asked = delivered.flatMap((sent) => [
    ...sent.questions,
    ...sent.requests,
  ]);
  return (
    asksAnew(message.questions, asked) || asksAnew(message.requests, asked)
  );
}

/**
 * Whether a message tells the person nothing the turn has not already told
 * them: no new attachment, number, date, code or link, no new name, no
 * question not asked yet, and it is not the next item of a list sent one
 * message at a time («Анна придёт…», then «Мария придёт…»). A message that
 * follows other work since the last delivery may report what that work
 * found in words alone, so it counts as nothing new only when it is status.
 */
export function addsNothingNew(
  message: SentMessage,
  delivered: readonly SentMessage[],
  options: { readonly afterWork: boolean }
) {
  if (delivered.length === 0) return false;
  const attachments = new Set(delivered.flatMap((sent) => sent.attachments));
  if (message.attachments.some((attachment) => !attachments.has(attachment))) {
    return false;
  }
  const codes = delivered.flatMap((sent) => sent.codes);
  if (
    message.codes
      .filter(isFact)
      .some((code) => !codes.some((known) => sameFact(code, known)))
  ) {
    return false;
  }
  const words = new Set(delivered.flatMap((sent) => sent.text.split(" ")));
  if (message.properNames.some((name) => !words.has(name))) return false;
  const questions = delivered.flatMap((sent) => sent.questions);
  if (
    message.questions.some(
      (question) =>
        !questions.some(
          (asked) => similarity(question, asked) >= sameQuestionSimilarity
        )
    )
  ) {
    return false;
  }
  const nextItem = delivered.some(
    (sent) =>
      !namesShared(message, sent) &&
      similarity(message.text, sent.text) >= nearDuplicateSimilarity
  );
  if (nextItem) return false;
  return options.afterWork ? statusWords.test(message.text) : true;
}
