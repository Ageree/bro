import { defineDynamic, defineTool, toolOutput } from "eve/tools";
import type { z } from "zod";
import { resolveModeValue } from "../lib/mode";
import {
  addReactionToMessageOutputSchema,
  reactToMessageOutputSchema,
} from "@shared/chat/reaction";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { reportedBrowserRunId } from "../lib/browser-use/report-caller";
import { withGroupedRoubles } from "../lib/delivery/amounts";
import { isSharedFileLink } from "../lib/sandbox/files";
import { taskFilesOfCaller } from "../lib/sandbox/pilot";
import { skillsLayout } from "../lib/skills/pilot";
import { markTurnDelivered } from "../lib/delivery/holds";
import {
  rewriteSendNotice,
  sendRefusal,
  sendRefusalSchema,
  skippedSendNotice,
  turnMustEnd,
  turnOpenedByBackgroundTask,
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
 * What a browser report's turn says to the person once its send was
 * dropped as past its answer: nothing more, until it acts on the errand
 * again (`workAfterSkip`). Outside the pilot of the cache-friendly step the
 * step loses both messaging tools then (`turnTools`); in the pilot they stay
 * offered and refuse (`agent/agent.ts`).
 */
function reportPastAnswer(context: {
  readonly messages: Parameters<typeof turnSends>[0];
  readonly session: {
    readonly auth: {
      readonly current: Parameters<typeof reportedBrowserRunId>[0];
    };
  };
}) {
  return (
    !turnOpenedByBackgroundTask(context.messages) &&
    reportedBrowserRunId(context.session.auth.current) !== undefined &&
    turnMustEnd(context.messages) &&
    !turnSends(context.messages).workAfterSkip
  );
}

/** What `react_to_message` answers past a browser report's answer. */
const pastAnswerReaction =
  "Not sent: this report turn is past its answer, so no reaction goes out. Do not say it was sent; end the turn now unless the report still asks you to act on the errand.";

type SentMessage = z.infer<typeof sendMessageOutputSchema>;

/**
 * A send of the task agent's report turn with nothing in it that a server
 * fetches before the person even reads it: the report may have built a URL
 * from the person's files, and the URL itself would carry their content out.
 * A native link is fetched for its preview and an attachment is downloaded
 * to be uploaded (Telegram, iMessage) or loaded from its URL (the web chat),
 * so both turn into plain text, which Telegram posts without a preview there
 * (`agent/channels/telegram.ts`). Only the links of the task agent's own
 * files stay attachments (`isSharedFileLink`): they lead to Bro alone.
 */
function withoutFetchedUrls(message: SentMessage): SentMessage {
  if (message.kind === "link") {
    const { replyTo, url } = message;
    return replyTo === undefined
      ? { kind: "message", text: url }
      : { kind: "message", replyTo, text: url };
  }
  const attachments = message.attachments ?? [];
  const own = attachments.filter(({ url }) => isSharedFileLink(url));
  if (own.length === attachments.length) return message;
  const text = [
    message.text,
    ...attachments
      .filter((attachment) => !own.includes(attachment))
      .map(({ url }) => url),
  ]
    .filter(Boolean)
    .join("\n");
  const sent: Extract<SentMessage, { kind: "message" }> = {
    kind: "message",
    text,
  };
  if (message.replyTo !== undefined) sent.replyTo = message.replyTo;
  if (own.length > 0) sent.attachments = own;
  return sent;
}

/**
 * `turn` holds what the current turn already sent and did, so a repeat, a
 * rephrased status with nothing new, or a send past the per-turn limit is
 * dropped here rather than posted, and a message claiming what no tool did
 * goes back to the model. `pastAnswer` drops every send of a browser
 * report's turn past its answer (`reportPastAnswer`). A message that goes
 * out is recorded for the turn's card tools (`markTurnDelivered`).
 */
function defineSendMessage(
  turn: ReturnType<typeof turnSends>,
  pastAnswer: boolean,
  loadSkill: boolean,
  taskReport: boolean
) {
  return defineTool({
    description:
      "Send exactly one user-visible message to the current conversation. This is the delivery path for questions, progress updates, blockers, and final answers that need words. Choose kind message for plain text, private image artifacts, and HTTPS attachments; text and attachments may be combined. Text is delivered exactly as written, so write it like a brief natural text message and do not use Markdown. On Telegram and iMessage attachments are downloaded and uploaded to the conversation, so the person receives real photos and files; the web chat renders them from the URL. Give the direct HTTPS URL of the file itself, such as an image URL, never a page that contains it; to send the photos from a page, call find_images with the page URL first and attach the image URLs it returns. Up to 10 attachments ride on one message and each must be about 10 MB or smaller; an attachment that cannot be downloaded falls back to a link. Set replyTo to record which message is being answered: use current for an ordinary answer, clarification, status update, or follow-up prompted by the current user message, including when the user changes topics; use task with a task ID from Eve's Task state for delayed background work; and use automation with the automation ID supplied by a scheduled report. Omit replyTo only when the message is genuinely standalone and does not answer any particular user message, such as an unsolicited announcement or proactive notice, or when no applicable handle is available. Use only handles present in the current context. Choose kind link with a URL to send a standalone native preview. Put an ordinary URL in message text when a preview is not wanted. When you list options, keep each price and fact with the option it was found for, and say «все» or «ни один» only of the options you checked. Call send_message multiple times only when you intentionally want separate messages. Call it directly without an assistant-text preamble, and do not repeat delivered content afterward.",
    inputSchema: sendMessageOutputSchema,
    execute(message, context) {
      if (pastAnswer) return { skipped: "past" as const };
      const refused = sendRefusal(message, turn);
      if (refused) return refused;
      markTurnDelivered(context.session);
      // «2000 ₽» goes out as «2 000 ₽» (`amounts.ts`).
      const sent = taskReport ? withoutFetchedUrls(message) : message;
      return sent.kind === "message" && sent.text !== undefined
        ? { ...sent, text: withGroupedRoubles(sent.text) }
        : sent;
    },
    toModelOutput(output) {
      const refused = sendRefusalSchema.safeParse(output).data;
      if (refused && "skipped" in refused) {
        return toolOutput.text(skippedSendNotice(refused.skipped));
      }
      if (refused) {
        return toolOutput.text(rewriteSendNotice(refused.rewrite, loadSkill));
      }
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

function defineReactToMessage(delivery: ChannelDelivery, pastAnswer: boolean) {
  const toggle = delivery.reactions === "toggle";
  return defineTool({
    description: toggle
      ? "Add or remove a native reaction on the user's current message. Use this instead of send_message when a reaction fully communicates a lightweight acknowledgement and words would add nothing. Supports thumbs_up, thumbs_down, heart, laugh, exclamation (emphasis), and question."
      : "Acknowledge the user's current message with one compact reaction displayed in the conversation. Use this instead of send_message when the reaction fully communicates the response and words would add nothing. Supports thumbs_up, thumbs_down, heart, laugh, exclamation (emphasis), and question.",
    inputSchema: toggle
      ? reactToMessageOutputSchema
      : addReactionToMessageOutputSchema,
    execute(reaction) {
      // An error result is no reaction: channels post only what parses as
      // one.
      if (pastAnswer) throw new Error(pastAnswerReaction);
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
      const pastAnswer = reportPastAnswer(context);
      const send_message = defineSendMessage(
        turnSends(context.messages),
        pastAnswer,
        // In the skills pilot a rewrite that asks for a tool says how to
        // get one whose group is not offered yet.
        skillsLayout(context) === "core",
        turnOpenedByBackgroundTask(context.messages) &&
          taskFilesOfCaller(context)
      );
      const messageOnly = { send_message };
      const interactive = delivery
        ? {
            react_to_message: defineReactToMessage(delivery, pastAnswer),
            send_message,
          }
        : messageOnly;

      type MessagingTools = typeof interactive | typeof messageOnly;

      return resolveModeValue<MessagingTools>(context, {
        interactive,
        "scheduled-report": messageOnly,
      });
    },
  },
});
