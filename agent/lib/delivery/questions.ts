import type { ModelMessage } from "ai";
import { z } from "zod";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import {
  currentTurnMessages,
  sendReachedPerson,
  startsTurn,
} from "./turn-sends";

/**
 * Tools that undo or change something the person has, which a question to
 * them in the same turn puts on hold. On 24.09 (RU d02) Bro asked
 * «Остановить её сейчас или оставить?» about a schedule and deleted it three
 * seconds later, in the same turn, with no answer.
 */
export const actionsHeldForAnswer = [
  "calendar-delete-event",
  "calendar-update-event",
  "profile__forget_all",
  "profile__remove_memory",
  "schedules-update",
  "workstreams__forget",
  "workstreams__forget_all",
] as const;

const sentTextSchema = z.object({ text: z.string() });

/**
 * Words of the held actions themselves — stop, delete, remove, cancel,
 * keep, forget, move — as a question about one uses them: «остановить или
 * оставить?», «удалить напоминание?», «перенести созвон?».
 */
const heldActionWords =
  /(?<!\p{L})(?:остан[оа]в|приостан|удал|убер|убра|отмен|оставить|оставля|оставим|оставлю|выключ|отключ|сотри|стере|стир|забыть|забуду|забудь|перенес|передвин|пауз|stop|delete|remove|cancel|keep|forget|pause|resched|move)/iu;

/** The same actions asked for: «удали», «отмени», «перенеси», «stop it». */
const heldActionRequest =
  /(?<!\p{L})(?:останови|приостанови|удали|убери|отмени|выключи|отключи|сотри|забудь|перенеси|передвинь|поставь\s+на\s+паузу|stop|delete|remove|cancel|forget|pause|reschedule|move)(?!\p{L})/iu;

/**
 * The prose a person reads: links, quoted titles and names go, so a `?` in a
 * query string or in «Что дальше?» asks nothing.
 */
function prose(text: string) {
  return text
    .replaceAll(/\]\([^)]*\)/gu, "]")
    .replaceAll(/https?:\/\/\S+/giu, " ")
    .replaceAll(/«[^»]*»|"[^"]*"|“[^”]*”|„[^“”]*[“”]/gu, " ");
}

/** Whether a message asks the person about one of the held actions. */
function asksAboutHeldAction(text: string) {
  return prose(text)
    .split(/(?<=[.!?？…])\s+|\n+/u)
    .some(
      (sentence) =>
        /[?？]\s*$/u.test(sentence.trim()) && heldActionWords.test(sentence)
    );
}

function messageText(message: ModelMessage) {
  if (!Array.isArray(message.content)) return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Whether the person's own message that started this turn asks for one of
 * the held actions — then the action is theirs, whatever Bro asked since.
 */
function personAskedForHeldAction(messages: readonly ModelMessage[]) {
  const opening = messages.findLast(startsTurn);
  if (opening?.role !== "user") return false;
  const text = messageText(opening);
  return !isBackgroundTurnText(text) && heldActionRequest.test(text);
}

/**
 * Whether the last message the current turn got through to the person asks
 * them about stopping, deleting, cancelling, keeping or moving something —
 * «Остановить её сейчас или оставить?». Their answer comes as their next
 * message, which starts a new turn; until then, those actions wait. A
 * courtesy question («Эконом подойдёт?»), an earlier message of the turn, a
 * quoted title with a `?`, and an action the person asked for themselves do
 * not hold anything.
 */
export function turnAwaitsAnswer(messages: readonly ModelMessage[]) {
  const turn = currentTurnMessages(messages);
  const delivered = new Set(
    turn.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result" &&
            part.toolName === "send_message" &&
            sendReachedPerson(part.output)
              ? [part.toolCallId]
              : []
          )
        : []
    )
  );
  const lastSent = turn
    .flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === "tool-call" &&
            part.toolName === "send_message" &&
            delivered.has(part.toolCallId)
              ? [sentTextSchema.safeParse(part.input).data?.text ?? ""]
              : []
          )
        : []
    )
    .at(-1);
  if (lastSent === undefined || !asksAboutHeldAction(lastSent)) return false;
  return !personAskedForHeldAction(messages);
}

/**
 * What the model is told while the held actions are out of its hands, so it
 * neither reaches for them nor says it did what it could not.
 */
export const heldForAnswerNote = `You asked the person a question in this turn about stopping, deleting, cancelling or moving something, and they have not answered yet. Until their next message, ${actionsHeldForAnswer.join(", ")} are not available. Do not do it and do not say it is done: end the turn and act on their answer.`;

/**
 * Whether the current turn already put an `ask_question` to the person. The
 * answer resumes the same turn rather than starting a new one, so this holds
 * from the question until the person's next own message.
 */
export function turnAskedQuestion(messages: readonly ModelMessage[]) {
  return currentTurnMessages(messages).some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === "tool-call" && part.toolName === "ask_question"
      )
  );
}
