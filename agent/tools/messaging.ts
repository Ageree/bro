import { defineDynamic, defineTool, toolOutput } from "eve/tools";
import { resolveModeValue } from "../lib/mode";
import {
  addReactionToMessageOutputSchema,
  reactToMessageOutputSchema,
} from "@shared/chat/reaction";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

/** What a conversation channel can do with a delivered message. */
interface ChannelDelivery {
  /** Whether the channel can deliver an attachment referenced by URL. */
  readonly attachmentUrls: boolean;
  /** Whether reactions can only be added, or added and removed. */
  readonly reactions: "add" | "toggle";
}

// A channel that is missing from this table gets plain message delivery only.
const channelDelivery = new Map<string, ChannelDelivery>([
  ["channel:eve", { attachmentUrls: true, reactions: "add" }],
  ["channel:photon", { attachmentUrls: false, reactions: "toggle" }],
  ["channel:telegram", { attachmentUrls: false, reactions: "toggle" }],
]);

function defineSendMessage(delivery: ChannelDelivery | undefined) {
  return defineTool({
    description:
      "Send exactly one user-visible message to the current conversation. This is the delivery path for questions, progress updates, blockers, and final answers that need words. Choose kind message for plain text, private image artifacts, and HTTPS attachments; text and attachments may be combined. Text is delivered exactly as written, so write it like a brief natural text message and do not use Markdown. Set replyTo to record which message is being answered: use current for an ordinary answer, clarification, status update, or follow-up prompted by the current user message, including when the user changes topics; use task with a task ID from Eve's Task state for delayed background work; and use automation with the automation ID supplied by a scheduled report. Omit replyTo only when the message is genuinely standalone and does not answer any particular user message, such as an unsolicited announcement or proactive notice, or when no applicable handle is available. Use only handles present in the current context. Choose kind link with a URL to send a standalone native preview. Put an ordinary URL in message text when a preview is not wanted. Call send_message multiple times only when you intentionally want separate messages. Call it directly without an assistant-text preamble, and do not repeat delivered content afterward.",
    inputSchema: sendMessageOutputSchema,
    execute(message) {
      return message;
    },
    toModelOutput(output) {
      const message = sendMessageOutputSchema.safeParse(output);
      const unsupported = [
        message.data?.replyTo
          ? "Native quoted replies are unavailable on this channel, so it was delivered as an ordinary message."
          : undefined,
        delivery?.attachmentUrls === false &&
        message.data?.kind === "message" &&
        message.data.attachments
          ? "Attachment uploads from a URL are unavailable on this channel, so each attachment was delivered as a link."
          : undefined,
      ].filter((note) => note !== undefined);
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
      ? "Add or remove a native iMessage Tapback on the user's current message. Use this instead of send_message when a reaction fully communicates a lightweight acknowledgement and words would add nothing. Supports thumbs_up, thumbs_down, heart, laugh, exclamation (emphasis), and question."
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
    "turn.started": (_event, context) => {
      const delivery = channelDelivery.get(context.channel.kind ?? "");
      const send_message = defineSendMessage(delivery);
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
