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
 * What the person wrote in this turn: the message they opened it with and
 * their answers to its questions, and nothing when Bro opened it — a browser
 * report, a scheduled result, a wakeup, whose text a page or a worker wrote.
 * A follow-up acts on these words only.
 */
export function personWordsThisTurn(messages: readonly ModelMessage[]) {
  const opening = messages.findLastIndex(startsTurn);
  const message = opening === -1 ? undefined : messages[opening];
  if (message?.role !== "user") return [];
  const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
  if (kind !== "user") return [];
  const text = messageText(message);
  if (isBackgroundTurnText(text)) return [];
  return [text, ...answersThisTurn(messages.slice(opening + 1))];
}

/** A word that makes a number next to it a one-time code: «SMS», "OTP". */
const codeContextPattern =
  /(?<!\p{L})(?:смс|sms|otp|одноразов\p{L}*|one[\s-]time|verification)(?!\p{L})/iu;

/**
 * «код 739204», «код подтверждения: 4821», "code is 7392" — a word for a
 * code right before the number, so «промокод 1234» or «код домофона 4567»
 * is not a one-time code.
 */
const codeLeadPattern =
  /(?<!\p{L})(?:код\p{L}*|code\p{L}*|пароль\p{L}*|password|пин|pin)(?:\s+(?:подтверждения|из|с|от|смс|sms|сообщения|письма|почты|сайта|банка|is|from|the))*[\s:—–-]*$/iu;

/** How far from the number a word like «SMS» still describes it. */
const codeContextReach = 25;

/**
 * A run of four to eight digits, as people copy a code out of a message —
 * «739204», «739 204», «73-92-04» — and not part of a longer number.
 */
const digitGroupPattern = /(?<![\d.,:])\d(?:[ \u00a0-]?\d){3,7}(?![\d.,:])/gu;

function digitGroups(text: string) {
  return [...text.matchAll(digitGroupPattern)].map((match) =>
    match[0].replaceAll(/\D/gu, "")
  );
}

/**
 * The one-time codes a text carries: a four-to-eight digit group a word for
 * a code leads or a word like «SMS» stands next to, or any such group at all
 * when the run is waiting for a code, where a bare number is how a code is
 * passed on.
 */
export function oneTimeCodesIn(
  text: string,
  options: { readonly awaitingCode: boolean }
) {
  return [...text.matchAll(digitGroupPattern)].flatMap((match) => {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(0, start);
    const near = [
      before.slice(-codeContextReach),
      text.slice(end, end + codeContextReach),
    ];
    const isCode =
      options.awaitingCode ||
      codeLeadPattern.test(before) ||
      near.some((words) => codeContextPattern.test(words));
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
  /^(?:(?:ну|и|а|так|бро)\s+)*(?:(?:что|как)(?:\s+(?:там|тут|дела|успехи|оно|продвигается|идет|получилось|по\s+\p{L}+|с\s+\p{L}+(?:\s+\p{L}+)?))*|есть\s+(?:новости|что\s+нибудь|результат)|новости|готово|статус|ну|и|any\s+news|any\s+update|whats\s+up|what\s+s\s+up|status|update|so|well|how\s+is\s+it\s+going|how\s+s\s+it\s+going)(?:\s+(?:там|уже|бро))*$/u;

/** Whether the words only ask how the errand stands. */
export function onlyAsksHowItStands(words: string) {
  const said = comparable(words);
  return said.length > 0 && statusQuestionPattern.test(said);
}
