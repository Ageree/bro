import type { SessionAuth } from "eve/context";
import { z } from "zod";

/**
 * Sentinel the interactive and scheduled-report instructions ask the model to
 * write once `send_message` already delivered the reply. It is bookkeeping for
 * the runtime, never something a person should read.
 */
const deliveryCompleteSentinel = "DELIVERY_COMPLETE";

/**
 * Assistant text a channel should deliver itself because the model answered in
 * plain text instead of calling `send_message`. Returns nothing when the model
 * wrote no text or only the sentinel that marks an already delivered reply. A
 * sentinel the model appended to real text is dropped rather than shown.
 */
export function fallbackDeliveryText(message: string | null | undefined) {
  const text = message?.replaceAll(deliveryCompleteSentinel, "").trim();
  if (!text) return undefined;
  return text;
}

/** The language a failure line is written in, guessed from the person's text. */
type ReplyLanguage = "en" | "ru";

const turnFailureTexts = {
  // The provider is out of credits, rate limited or down: the owner's
  // problem, and one that passes, so none of it reaches the chat.
  outage: {
    en: "taking a quick nap, back soon",
    ru: "я прилёг, скоро вернусь",
  },
  // Anything else that broke the turn, where trying again may well help.
  failure: {
    en: "Something broke while I was working on your request. Please try again.",
    ru: "Что-то сломалось, пока я разбирался с твоей просьбой. Попробуй ещё раз.",
  },
} as const satisfies Record<string, Record<ReplyLanguage, string>>;

const cyrillicPattern = /\p{Script=Cyrillic}/u;
const latinPattern = /\p{Script=Latin}/u;

/**
 * Bro speaks Russian by default, so only a message written in Latin script
 * without a single Cyrillic letter is answered in English.
 */
export function replyLanguageFor(text: string | undefined): ReplyLanguage {
  if (!text || cyrillicPattern.test(text)) return "ru";
  return latinPattern.test(text) ? "en" : "ru";
}

const failureDetailsSchema = z
  .object({
    statusCode: z.number().optional(),
    upstreamStatusCode: z.number().optional(),
  })
  .optional();

/**
 * Whether the model provider itself is unavailable: out of credits (402), rate
 * limited (429) or failing (5xx). eve reports every failed model call as
 * `MODEL_CALL_FAILED`, including an overflowing context or a rejected request,
 * where «back soon» would not be true.
 */
function isModelOutage(failure: {
  readonly code: string;
  readonly details?: unknown;
}) {
  if (failure.code !== "MODEL_CALL_FAILED") return false;
  const details = failureDetailsSchema.safeParse(failure.details).data;
  return [details?.statusCode, details?.upstreamStatusCode].some(
    (status) =>
      status !== undefined &&
      (status === 402 || status === 429 || status >= 500)
  );
}

/**
 * The one line a messaging channel posts when a person's turn failed, in the
 * language they wrote in and without any of the internals.
 */
export function turnFailureNotice(
  failure: { readonly code: string; readonly details?: unknown },
  language: ReplyLanguage
) {
  const kind = isModelOutage(failure) ? "outage" : "failure";
  return turnFailureTexts[kind][language];
}

/**
 * The language the channel recorded for the message that started this turn.
 * Channels store it as the `replyLanguage` attribute when they accept the
 * message, because a failed turn has no text of its own to go by.
 */
export function sessionReplyLanguage(auth: SessionAuth): ReplyLanguage {
  const caller = auth.current ?? auth.initiator;
  return caller?.attributes.replyLanguage === "en" ? "en" : "ru";
}
