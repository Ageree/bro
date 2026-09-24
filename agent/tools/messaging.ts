import { defineDynamic, defineTool, toolOutput } from "eve/tools";
import { resolveModeValue } from "../lib/mode";
import {
  addReactionToMessageOutputSchema,
  reactToMessageOutputSchema,
} from "@shared/chat/reaction";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { personLanguage } from "../lib/delivery/language";
import {
  bouncesForLanguage,
  type SentMessage,
  sendSkipReason,
  skippedSendNotice,
  turnSends,
  wrongLanguageNotice,
} from "../lib/delivery/turn-sends";
import { z } from "zod";

/** What a conversation channel can do with a delivered message. */
interface ChannelDelivery {
  /** Whether reactions can only be added, or added and removed. */
  readonly reactions: "add" | "toggle";
}

// A channel that is missing from this table gets plain message delivery only.
const channelDelivery = new Map<string, ChannelDelivery>([
  ["channel:eve", { reactions: "add" }],
  ["channel:photon", { reactions: "toggle" }],
  ["channel:telegram", { reactions: "toggle" }],
]);

/**
 * What `send_message` returns instead of the message when it drops a send.
 * Channels deliver only results that parse as a message, so this one never
 * reaches the person.
 */
const skippedSendSchema = z.discriminatedUnion("skipped", [
  z.object({ skipped: z.enum(["duplicate", "limit"]) }),
  z.object({ language: z.enum(["en", "ru"]), skipped: z.literal("language") }),
]);

/**
 * `delivered` holds what the current turn already sent, so a repeat or a send
 * past the per-turn limit is dropped here rather than posted again. A send in
 * the other language than the person's latest message (`replyLanguage`) is
 * bounced back for a rewrite a limited number of times (`languageSkips`).
 */
function defineSendMessage(
  delivered: readonly SentMessage[],
  replyLanguage: "en" | "ru" | null,
  languageSkips: number
) {
  return defineTool({
    description:
      "Send exactly one user-visible message to the current conversation. This is the delivery path for questions, progress updates, blockers, and final answers that need words. Choose kind message for plain text, private image artifacts, and HTTPS attachments; text and attachments may be combined. Text is delivered exactly as written, so write it like a brief natural text message and do not use Markdown. On Telegram and iMessage attachments are downloaded and uploaded to the conversation, so the person receives real photos and files; the web chat renders them from the URL. Give the direct HTTPS URL of the file itself, such as an image URL, never a page that contains it; to send the photos from a page, call find_images with the page URL first and attach the image URLs it returns. Up to 10 attachments ride on one message and each must be about 10 MB or smaller; an attachment that cannot be downloaded falls back to a link. Set replyTo to record which message is being answered: use current for an ordinary answer, clarification, status update, or follow-up prompted by the current user message, including when the user changes topics; use task with a task ID from Eve's Task state for delayed background work; and use automation with the automation ID supplied by a scheduled report. Omit replyTo only when the message is genuinely standalone and does not answer any particular user message, such as an unsolicited announcement or proactive notice, or when no applicable handle is available. Use only handles present in the current context. Choose kind link with a URL to send a standalone native preview. Put an ordinary URL in message text when a preview is not wanted. Call send_message multiple times only when you intentionally want separate messages. Call it directly without an assistant-text preamble, and do not repeat delivered content afterward.",
    inputSchema: sendMessageOutputSchema,
    execute(message) {
      const skipped = sendSkipReason(message, delivered);
      if (skipped) return { skipped };
      if (
        replyLanguage &&
        bouncesForLanguage(message, replyLanguage, languageSkips)
      ) {
        return { language: replyLanguage, skipped: "language" as const };
      }
      return message;
    },
    toModelOutput(output) {
      const skipped = skippedSendSchema.safeParse(output).data;
      if (skipped?.skipped === "language") {
        return toolOutput.text(wrongLanguageNotice(skipped.language));
      }
      if (skipped) return toolOutput.text(skippedSendNotice(skipped.skipped));
      const message = sendMessageOutputSchema.safeParse(output);
      const unsupported = message.data?.replyTo
        ? [
            "Native quoted replies are unavailable on this channel, so it was delivered as an ordinary message.",
          ]
        : [];
      return toolOutput.text(
        [
          "The message was submitted to the active channel. Do not repeat it in assistant text.",
          ...unsupported,
        ].join(" ")
      );
    },
  });
}

function defineReactToMessage(delivery: ChannelDelivery) {
  const toggle = delivery.reactions === "toggle";
  return defineTool({
    description: toggle
      ? "Add or remove a native reaction on the user's current message. Use this instead of send_message when a reaction fully communicates a lightweight acknowledgement and words would add nothing. Supports thumbs_up, thumbs_down, heart, laugh, exclamation (emphasis), and question."
      : "Acknowledge the user's current message with one compact reaction displayed in the conversation. Use this instead of send_message when the reaction fully communicates the response and words would add nothing. Supports thumbs_up, thumbs_down, heart, laugh, exclamation (emphasis), and question.",
    inputSchema: toggle
      ? reactToMessageOutputSchema
      : addReactionToMessageOutputSchema,
    execute(reaction) {
      return reaction;
    },
    toModelOutput() {
      return toolOutput.text(
        "The reaction was submitted to the active conversation. Do not repeat it in assistant text."
      );
    },
  });
}

export default defineDynamic({
  events: {
    // Resolved before every model step, so send_message knows what the
    // current turn has already delivered and which language the person
    // wrote in.
    "step.started": (_event, context) => {
      const delivery = channelDelivery.get(context.channel.kind ?? "");
      const sends = turnSends(context.messages);
      const send_message = defineSendMessage(
        sends.delivered,
        resolveModeValue(context, {
          interactive: personLanguage(context.messages) ?? null,
        }),
        sends.languageSkips
      );
      const messageOnly = { send_message };
      const interactive = delivery
        ? { react_to_message: defineReactToMessage(delivery), send_message }
        : messageOnly;

      type MessagingTools = typeof interactive | typeof messageOnly;

      return resolveModeValue<MessagingTools>(context, {
        interactive,
        "scheduled-report": messageOnly,
      });
    },
  },
});
