import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { answersThisTurn } from "@agent/lib/browser-use/said";
import { placeMarker, positionMarker } from "@agent/lib/location/markers";
import { isLocationLine } from "@agent/lib/location/note";
import { withoutSecrets } from "@agent/lib/privacy/secrets";
import { splitTurn } from "@agent/lib/skills/tools";
import { mediaMarkers, stems, turnWords } from "@agent/lib/skills/triggers";
import { routerStateLimits } from "./questions";

/** The location pilot's markers of a point the person sent. */
const locationMarkers = [positionMarker, placeMarker] as const;

/**
 * What a place after «приду в/на/к» must not be: «когда буду в настроении»,
 * «приду к выводу», «вернусь к работе», «выйду из себя» speak of no place.
 */
const notAPlace = String.raw`(?!\s+((себя|себе|it|this|that|them|know|see|meet|think|do|terms|a decision|a conclusion|the point|работе)(?!\p{L})|норм|форм|настроени|курсе|связи|сети|силах|состояни|отпуск|вывод|решени|согласи|мнени|пониман|итог|цел[иь]|финал|общему|делу|теме|вопрос))`;

/**
 * The person's words of where they are or will be, or of a reminder bound
 * to a place (`L`, with the markers): the decision model gave no group to
 * «напомни купить хлеб, когда приду на Тверскую 7» (15.10). Only words that
 * clearly mean the person's own place: «рядом с текстом», «ближайший
 * понедельник» and «когда буду свободен» are none of it.
 */
const placeBound = stems(
  String.raw`когда\s+(я\s+)?(приду|приеду|доеду|доберусь|окажусь|вернусь|буду|подойду|подъеду)\s+((в|во|на|до|к|ко)(?!\p{L})${notAPlace}|(домой|дома|сюда|туда|там)(?!\p{L}))`,
  String.raw`как\s+(только\s+)?(я\s+)?(приду|приеду|окажусь|доеду|доберусь|вернусь домой)(?!\p{L})`,
  String.raw`когда\s+(я\s+)?(уйду|выйду|уеду)\s+(из|с|со|от)(?!\p{L})${notAPlace}`,
  String.raw`(уйду|выйду|уеду|ухожу|выхожу)\s+из\s+дома`,
  String.raw`где\s+я\s+(сейчас|нахожусь|находил\p{L}*|был[аи]?|припарковал\p{L}*|парковал\p{L}*|поставил\p{L}*\s+машин|оставил\p{L}*\s+машин)(?!\p{L})`,
  String.raw`где\s+я\s*\?|где\s+(сейчас\s+)?нахожусь|где\s+моя\s+машин`,
  String.raw`рядом\s+со\s+мной|поблизости|неподал[её]ку|недалеко\s+от\s+меня`,
  String.raw`when\s+i\s+(get|arrive|come)\s+((home|back|there|here)(?!\p{L})|(to|at)(?!\p{L})${notAPlace})`,
  String.raw`when\s+i\s+leave(?!\s+(a|an|it|this|that|feedback|comments?|reviews?|notes?)(?!\p{L}))`,
  String.raw`where\s+am\s+i|where\s+did\s+i\s+park|where\s+i\s+parked|near\s+me|nearby|close\s+to\s+me`
);

/**
 * A run of four digits or more, spaces, dashes, dots and brackets between
 * them allowed: a phone, an account, a card. The router needs none of them:
 * «позвони на [число]» goes where «позвони на 8 916 …» goes.
 */
const digitRun = /\d(?:[\s().-]?\d){3,}/gu;

/** A file the model sees, or a channel's marker of one. */
const mediaPresence = /\[(?:фото|документ|видео|файл)/u;

const sentTextSchema = z.object({ text: z.string() });

const sendCallSchema = z.object({
  input: sentTextSchema,
  toolCallId: z.string(),
  toolName: z.literal("send_message"),
  type: z.literal("tool-call"),
});

const filePartSchema = z.object({ type: z.enum(["file", "image"]) });

/**
 * The text without the location pilot's context lines (`Геопозиция: …`): an
 * address and a time the decision model has no need of. Its bare markers in
 * the person's text — «[геопозиция]», «[место]» — stay: they are what the
 * question of `places` reads.
 */
function withoutLocationLines(text: string) {
  return text
    .split("\n")
    .filter((line) => !isLocationLine(line))
    .join("\n");
}

/**
 * What a third party may read of a text: the first `limit` characters
 * with credentials, codes, card and document numbers cut out
 * (`withoutSecrets`), and every run of four digits or more as «[число]».
 */
function cleaned(text: string, limit: number) {
  return withoutSecrets(text, limit).replaceAll(digitRun, "[число]");
}

/** A long message as its head and its tail, each cleaned. */
function headAndTail(text: string) {
  const characters = Array.from(text.trim());
  if (characters.length <= routerStateLimits.text) {
    return cleaned(text, routerStateLimits.text);
  }
  return `${cleaned(characters.slice(0, routerStateLimits.head).join(""), routerStateLimits.head)} … ${cleaned(characters.slice(-routerStateLimits.tail).join(""), routerStateLimits.tail)}`;
}

/** Bro's last `send_message` in `history`, as its call and its text. */
function lastSend(history: readonly ModelMessage[]) {
  for (const message of history.toReversed()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const call = message.content
      .flatMap((part) => sendCallSchema.safeParse(part).data ?? [])
      .at(-1);
    if (call !== undefined) {
      return {
        message: {
          content: [call],
          role: "assistant" as const,
        } satisfies ModelMessage,
        text: call.input.text,
      };
    }
  }
  return undefined;
}

/**
 * The turn as the tool router reads it: the person's words of the turn (its
 * own messages, without eve's context and the slots' records, and without
 * the location pilot's context lines), Bro's last message before the turn,
 * and from them the state string the decision model gets, cleaned of
 * secrets and long numbers, with its digest.
 *
 * - `prevCall`: the assistant message of only that `send_message` call,
 *   for the skills' triggers (`skillsForTurn`): Bro's question before
 *   paying, its ask for readings, its answer to a schedule's report.
 * - `mediaOnly`: the turn sent a photo or a file with no words of its own.
 * - `located`: the turn carries the location pilot's marker of a point, or
 *   the person's words of their own place (`placeBound`).
 * - `answers`: the person's answers to `ask_question` in this turn, typed
 *   or picked: eve resumes the same turn with them as tool results, and
 *   «Позвонить» may want a group the opening words did not. They change
 *   the digest, so the step after one asks the router again, as for words
 *   written mid-turn.
 */
export function routerTurnText(messages: readonly ModelMessage[]) {
  const { history, input } = splitTurn(messages);
  const words = withoutLocationLines(turnWords(input)).trim();
  const previous = lastSend(history);
  const { answers } = answersThisTurn(
    messages.slice(history.length + input.length)
  );
  const state = [
    ...(previous === undefined
      ? []
      : [
          `Предыдущее сообщение Бро: ${cleaned(previous.text, routerStateLimits.prev)}`,
        ]),
    `Сообщение человека: ${headAndTail(words)}`,
    ...answers.map(
      (answer) =>
        `Ответ человека на вопрос Бро: ${cleaned(answer, routerStateLimits.prev)}`
    ),
  ].join("\n");
  const filesSent = input.some(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((part) => filePartSchema.safeParse(part).success)
  );
  const bare = words.replaceAll(mediaMarkers, " ").replaceAll(/\s+/gu, " ");
  return {
    answers,
    digest: createHash("sha256").update(state).digest("hex").slice(0, 32),
    history,
    input,
    located:
      locationMarkers.some((marker) => words.includes(marker)) ||
      placeBound.test(words),
    mediaOnly:
      (filesSent || mediaPresence.test(words)) && bare.trim().length < 15,
    prevCall: previous?.message,
    state,
    withPrev: previous !== undefined,
  };
}
