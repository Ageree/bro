import { defineDynamic, defineTool, toolOutput } from "eve/tools";
import { resolveModeValue } from "../lib/mode";
import {
  addReactionToMessageOutputSchema,
  reactToMessageOutputSchema,
} from "@shared/chat/reaction";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { withGroupedRoubles } from "../lib/delivery/amounts";
import {
  rewriteSendNotice,
  sendRefusal,
  sendRefusalSchema,
  skippedSendNotice,
  turnSends,
} from "../lib/delivery/turn-sends";

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
 * `turn` holds what the current turn already sent and did, so a repeat, a
 * rephrased status with nothing new, or a send past the per-turn limit is
 * dropped here rather than posted, and a message claiming what no tool did
 * goes back to the model.
 */
function defineSendMessage(turn: ReturnType<typeof turnSends>) {
  return defineTool({
    description:
      "Send exactly one user-visible message to the current conversation. This is the delivery path for questions, progress updates, blockers, and final answers that need words. Choose kind message for plain text, private image artifacts, and HTTPS attachments; text and attachments may be combined. Text is delivered exactly as written, so write it like a brief natural text message and do not use Markdown. On Telegram and iMessage attachments are downloaded and uploaded to the conversation, so the person receives real photos and files; the web chat renders them from the URL. Give the direct HTTPS URL of the file itself, such as an image URL, never a page that contains it; to send the photos from a page, call find_images with the page URL first and attach the image URLs it returns. Up to 10 attachments ride on one message and each must be about 10 MB or smaller; an attachment that cannot be downloaded falls back to a link. Set replyTo to record which message is being answered: use current for an ordinary answer, clarification, status update, or follow-up prompted by the current user message, including when the user changes topics; use task with a task ID from Eve's Task state for delayed background work; and use automation with the automation ID supplied by a scheduled report. Omit replyTo only when the message is genuinely standalone and does not answer any particular user message, such as an unsolicited announcement or proactive notice, or when no applicable handle is available. Use only handles present in the current context. Choose kind link with a URL to send a standalone native preview. Put an ordinary URL in message text when a preview is not wanted. When you list options, keep each price and fact with the option it was found for, and say «все» or «ни один» only of the options you checked. Call send_message multiple times only when you intentionally want separate messages. Call it directly without an assistant-text preamble, and do not repeat delivered content afterward.",
    inputSchema: sendMessageOutputSchema,
    execute(message) {
      return (
        sendRefusal(message, turn) ??
        // «2000 ₽» goes out as «2 000 ₽» (`amounts.ts`).
        (message.kind === "message" && message.text !== undefined
          ? { ...message, text: withGroupedRoubles(message.text) }
          : message)
      );
    },
    toModelOutput(output) {
      const refused = sendRefusalSchema.safeParse(output).data;
      if (refused && "skipped" in refused) {
        return toolOutput.text(skippedSendNotice(refused.skipped));
      }
      if (refused) return toolOutput.text(rewriteSendNotice(refused.rewrite));
      const message = sendMessageOutputSchema.safeParse(output);
      const unsupported = message.data?.replyTo
        ? [
            "Native quoted replies are unavailable on this channel, so it was delivered as an ordinary message.",
          ]
        : [];
      return toolOutput.text(
        [
          "The message was submitted to the active channel. Do not repeat or rephrase it, in assistant text or in another send_message. Send another message in this turn only with something new — a result of further work, another option, a number, a link, a question; when nothing new is left, end the turn now without calling any tool.",
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
    // current turn has already delivered.
    "step.started": (_event, context) => {
      const delivery = channelDelivery.get(context.channel.kind ?? "");
      const send_message = defineSendMessage(turnSends(context.messages));
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
