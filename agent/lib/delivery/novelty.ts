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
 * The endings one word takes as it declines, a set per declension: «Артур»,
 * «Артура», «Артуром», «Лавка», «Лавке», «Лавку», «Шереметьево»,
 * «Шереметьеве» and «Иванов», «Ивановым»; «Игорь», «Игоря» and «Таня»,
 * «Тане»; «Мария», «Марии»; «Профсоюзная», «Профсоюзной»; an English plural.
 * Two forms of one word take endings of one declension, so «Виктор» and
 * «Виктория», «Лена» and «Леня», «Эмиль» and «Эмилия» stay two people.
 * «Валентина» is also a case of «Валентин»: only the person naming both
 * keeps those two apart (`distinctStems`).
 */
const declensions = [
  "- а у о ом е ы ов ам ами ах и ой ою ым",
  "- ь й я ю ем е и ей ею ям ями ях ев",
  "ия ии ию ией ий ие ием иям иями иях",
  "ая ой ую ое ый ые ых ым ыми ого ому ий ее яя юю его ему ими их им ей ью",
  "- s es",
].map(
  (line) =>
    new Set(line.split(" ").map((ending) => (ending === "-" ? "" : ending)))
);

/** Letters two forms of one word share at least. */
const stemLength = 3;

/**
 * Whether two normalized words are one word in two grammatical forms: after
 * a common stem they differ only in endings of one declension. In RU d15
 * (25.09) the same address went out twice because the second message named
 * «Артур» where the first had «Артура». «Мария» and «Марина» share «мари»,
 * but «на» is no ending, so they stay two people. The stem the two forms
 * share, or nothing when they are two words.
 */
function sharedStem(word: string, other: string) {
  let shared = 0;
  while (
    shared < word.length &&
    shared < other.length &&
    word[shared] === other[shared]
  ) {
    shared += 1;
  }
  for (let stem = shared; stem >= stemLength; stem -= 1) {
    const [ending, otherEnding] = [word.slice(stem), other.slice(stem)];
    if (
      declensions.some(
        (endings) => endings.has(ending) && endings.has(otherEnding)
      )
    ) {
      return word.slice(0, stem);
    }
  }
  return undefined;
}

function sameWord(word: string, other: string) {
  return word === other || sharedStem(word, other) !== undefined;
}

/**
 * Whether `word` occurs among `words` in some grammatical form. A word on
 * one of `distinct` stems counts only as written: the person named two
 * people on it.
 */
function knownWord(
  word: string,
  words: ReadonlySet<string>,
  distinct: readonly string[] = []
) {
  if (words.has(word)) return true;
  if (distinct.some((stem) => word.startsWith(stem))) return false;
  for (const known of words) {
    if (sameWord(word, known)) return true;
  }
  return false;
}

/**
 * The stems the person's own message uses for two different words: «Валентин
 * и Валентина придут» names two people whose names differ only as a case
 * ending would. Names on these stems are compared as written.
 */
export function distinctStems(text: string) {
  const words = [...new Set(normalizedText(text).split(" "))];
  return [
    ...new Set(
      words.flatMap((word, index) =>
        words.slice(index + 1).flatMap((other) => sharedStem(word, other) ?? [])
      )
    ),
  ];
}

function wordsOf(messages: readonly SentMessage[]) {
  return new Set(messages.flatMap((sent) => sent.text.split(" ")));
}

/**
 * Whether each name of one message also occurs as a word of the other. A
 * sentence opener that only changed case, «Готово! Напомню» after «Готово,
 * напомню», still occurs, and so does a name in another case («Артура» and
 * «Артур»: d15 sent near copies that differed only so); a different person
 * or place does not. On a stem in `distinct` a name counts only as written.
 */
export function namesShared(
  message: SentMessage,
  other: SentMessage,
  distinct: readonly string[] = []
) {
  const words = wordsOf([other]);
  return message.names.every((name) => knownWord(name, words, distinct));
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

/**
 * Words a message about a browser errand is made of: the run was started or
 * handed the message, it is looking, the result will follow.
 */
const errandWords =
  /(?:^| )(?:запустил\p{L}*|запущен\p{L}*|передал\p{L}*|поручени\p{L}*|started|handed)(?= |$)/u;

/** Whether a message talks about an errand at work rather than a result. */
export function announcesErrand(message: SentMessage) {
  return (
    laterWords.test(message.text) ||
    busyWords.test(message.text) ||
    errandWords.test(message.text)
  );
}

/**
 * Whether a message carries a number, a link or a name that none of `known`
 * carries in any form.
 */
export function tellsBeyond(
  message: SentMessage,
  known: readonly SentMessage[]
) {
  const codes = known.flatMap((sent) => sent.codes);
  const words = wordsOf(known);
  return (
    message.codes
      .filter(isFact)
      .some((code) => !codes.some((sent) => sameFact(code, sent))) ||
    message.properNames.some((name) => !knownWord(name, words))
  );
}

/** Whether a message carries a picture, a number, a code, a link or a name. */
export function carriesFacts(message: SentMessage) {
  return (
    message.attachments.length > 0 ||
    message.codes.some((code) => isFact(code)) ||
    message.properNames.length > 0
  );
}

/**
 * Whether a message tells something rather than announcing it. «Вот что
 * нашёл:», «Какой вариант берём?» or «Секунду, смотрю» tell nothing yet.
 */
export function tellsFacts(message: SentMessage) {
  return !announcesWork(message) && carriesFacts(message);
}

/**
 * Verbs a person gives Bro a task with, which a bare reaction does not
 * answer: «посчитай чаевые», «переведи», «find me …».
 */
const taskVerbs =
  /(?<!\p{L})(?:посчитай|посчитайте|сосчитай|переведи|переведите|найди|найдите|подскажи|подскажите|расскажи|расскажите|объясни|объясните|покажи|покажите|проверь|проверьте|сделай|сделайте|напомни|напомните|поставь|поставьте|добавь|добавьте|запиши|запишите|закажи|закажите|купи|купите|забронируй|забронируйте|отмени|отмените|calculate|translate|find|explain|show|check|remind|book|order)(?!\p{L})/iu;

/**
 * Whether a person's message wants something back — a question, a request
 * or a task — rather than only acknowledging, as «спасибо!» or «ок» do.
 */
export function asksForSomething(text: string) {
  return (
    questionsOf(text).length > 0 ||
    requestsOf(text).length > 0 ||
    taskVerbs.test(text)
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

const cyrillicWord = /^\p{Script=Cyrillic}+$/u;
const latinWord = /^\p{Script=Latin}+$/u;

/** The alphabet most letters of a normalized text are written in. */
function alphabetOf(text: string) {
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (cyrillic === latin) return undefined;
  return cyrillic > latin ? cyrillicWord : latinWord;
}

/** A translation has at least this many words in the other alphabet. */
const translationWords = 3;

/**
 * Whether a message is mostly words in the other alphabet than the turn's
 * own — the person's request, or else the first message sent — that no
 * delivered message has used: a translation, or a text the person asked for
 * in another language. It is new text rather than the answer rephrased,
 * though it carries no number or name of its own.
 */
function writesAnotherLanguage(
  message: SentMessage,
  delivered: readonly SentMessage[],
  request: SentMessage | undefined
) {
  const own = alphabetOf(request?.text ?? delivered[0]?.text ?? "");
  if (!own) return false;
  const words = message.text.split(" ").filter((word) => /\p{L}/u.test(word));
  const foreign = words.filter(
    (word) => word.length > 1 && !own.test(word) && /^\p{L}+$/u.test(word)
  );
  const known = wordsOf(delivered);
  const unsent = foreign.filter((word) => !knownWord(word, known));
  return (
    foreign.length >= translationWords &&
    foreign.length * 2 >= words.length &&
    unsent.length * 3 >= foreign.length * 2
  );
}

/**
 * Whether a message tells the person nothing the turn has not already told
 * them: no new attachment, number, date, code or link, no new name in any
 * of its forms, no question not asked yet, it is not the next item of a
 * list sent one message at a time («Анна придёт…», then «Мария придёт…»),
 * and it is no translation into another language. A message that follows
 * other work since the last delivery may report what that work found in
 * words alone, so it counts as nothing new only when it is status.
 */
export function addsNothingNew(
  message: SentMessage,
  delivered: readonly SentMessage[],
  options: {
    readonly afterWork: boolean;
    /** Stems on which the person named two people (`distinctStems`). */
    readonly distinct?: readonly string[];
    /** The person's own message that opened the turn, if they opened it. */
    readonly request?: SentMessage;
  }
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
  const words = wordsOf(delivered);
  if (
    message.properNames.some(
      (name) => !knownWord(name, words, options.distinct)
    )
  ) {
    return false;
  }
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
      !namesShared(message, sent, options.distinct) &&
      similarity(message.text, sent.text) >= nearDuplicateSimilarity
  );
  if (nextItem) return false;
  if (writesAnotherLanguage(message, delivered, options.request)) return false;
  return options.afterWork ? statusWords.test(message.text) : true;
}

/**
 * The sentences of a message that tell rather than ask: neither a question
 * nor a request to the person.
 */
function statementsOf(text: string) {
  return sentencesOf(text).filter(
    (sentence) =>
      questionsOf(sentence).length === 0 && requestsOf(sentence).length === 0
  );
}

/**
 * A limit a person sets on what they ask for, even inside their question: «до
 * 2500 на человека», «не дороже 5 000 ₽», «на четверых». A time is not one:
 * «успею ли я к 18:00?» asks about it.
 */
const personLimit =
  /(?<!\p{L})(?:до|не дороже|не больше|не более|максимум|в пределах|бюджет\p{L}*|на)\s+(?:\d[\d \u00A0]*(?:[.,]\d+)?(?![\d:.,])(?:\s*(?:₽|руб\p{L}*|тыс\p{L}*|человек\p{L}*|чел\.?|персон\p{L}*))?|(?:двоих|троих|четверых|пятерых|шестерых)(?!\p{L}))/giu;

/**
 * What the person's own message states rather than asks: its statements, and
 * the limits it sets inside a question. «Где поужинать до 2500 на человека?»
 * asks for a place and states the budget.
 */
export function statedIn(text: string) {
  const limits = sentencesOf(text)
    .filter((sentence) => questionsOf(sentence).length > 0)
    .flatMap((sentence) => sentence.match(personLimit) ?? []);
  return [...statementsOf(text), ...limits].join("\n");
}

/**
 * Whether a message that asks the person something wraps its question in the
 * answer told again: its other sentences name numbers, links, places or
 * people, at least one of them a delivered message named, and each of them
 * one a delivered message named or the person stated themselves. In RU d03
 * (25.09) the answer named two restaurants, and the offer to book came
 * wrapped in «Авокадо — единственный найденный вариант… бюджет до 2 500 ₽
 * подтвердить не получилось»: a second telling that contradicted the first.
 * The question alone would have been news.
 *
 * `stated` is what the person's message states, without what it asks
 * (`statedIn`): the place or time they ask about («успею ли я к 18:00?») is
 * what the answer has to tell, not something they already heard.
 */
export function retellsAroundQuestion(
  text: string,
  message: SentMessage,
  delivered: readonly SentMessage[],
  stated: SentMessage | undefined
) {
  if (delivered.length === 0) return false;
  if (message.questions.length === 0 && message.requests.length === 0) {
    return false;
  }
  const attachments = new Set(delivered.flatMap((sent) => sent.attachments));
  if (message.attachments.some((attachment) => !attachments.has(attachment))) {
    return false;
  }
  const sentCodes = delivered.flatMap((sent) => sent.codes);
  const sentWords = wordsOf(delivered);
  const told = stated ? [...delivered, stated] : delivered;
  const toldCodes = told.flatMap((sent) => sent.codes);
  const toldWords = wordsOf(told);
  const toldNames = new Set(delivered.flatMap((sent) => sent.properNames));
  const statements = statementsOf(text);
  const facts = statements.flatMap((statement) =>
    codesOf(statement).filter(isFact)
  );
  // A capital opening the sentence names a place too once a delivered
  // message named it: «Авокадо» — единственный вариант».
  const names = statements.flatMap((statement) =>
    properNamesOf(statement).concat(
      namesOf(statement).filter((name) => knownWord(name, toldNames))
    )
  );
  const repeatsSent =
    facts.some((code) => sentCodes.some((known) => sameFact(code, known))) ||
    names.some((name) => knownWord(name, sentWords));
  return (
    repeatsSent &&
    facts.every((code) => toldCodes.some((known) => sameFact(code, known))) &&
    names.every((name) => knownWord(name, toldWords))
  );
}
