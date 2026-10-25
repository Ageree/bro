import { defineDynamic, defineTool, toolOutput } from "eve/tools";
import type { z } from "zod";
import { resolveModeValue } from "../lib/mode";
import {
  addReactionToMessageOutputSchema,
  reactToMessageOutputSchema,
} from "@shared/chat/reaction";
import {
  maximumMessageAttachments,
  sendMessageOutputSchema,
} from "@shared/chat/message-delivery";
import { reportedBrowserRunId } from "../lib/browser-use/report-caller";
import { openedByPersonErrandReport } from "../lib/cards/caller";
import { cardsOffered } from "../lib/cards/enabled";
import { withGroupedRoubles } from "../lib/delivery/amounts";
import { withHttpsLinks, withVisibleLinks } from "../lib/delivery/links";
import { withExactBroInviteLinks } from "../lib/bro-to-bro/exact-invite";
import { withExactLoginHandoffLink } from "../lib/login-handoff/exact-link";
import { isSharedFileLink } from "../lib/sandbox/files";
import {
  knownSharedLinks,
  withExactSharedLinks,
} from "../lib/sandbox/exact-link";
import { reportTurnHoldsFiles, taskFilesOfCaller } from "../lib/sandbox/pilot";
import { skillsLayout } from "../lib/skills/pilot";
import { markTurnDelivered } from "../lib/delivery/holds";
import { withoutEmptyDeliveryMarker } from "../lib/delivery/empty";
import { deliveryCompleteSentinel } from "../lib/delivery/fallback";
import { earlyReplyPilotOfCaller } from "../lib/delivery/pilot";
import {
  headsUpDeliveredNotice,
  opensWithHeadsUp,
  rewriteSendNotice,
  sendRefusal,
  sendRefusalSchema,
  skippedSendNotice,
  turnMustEnd,
  turnOpenedByBackgroundTask,
  turnSends,
} from "../lib/delivery/turn-sends";
import { stepStartedEventSchema } from "../lib/turn-kind/step";
import { broReportCaller } from "@agent/lib/bro-to-bro/report-caller";
import { renewBroReportTurn } from "@agent/lib/bro-to-bro/report-turn";
import { phoneReportCaller } from "@agent/lib/phone/report-caller";
import { renewPhoneReportTurn } from "@agent/lib/phone/report-lease";

/** A report's turn whose report may already be settled: a call's or a Bro ↔ Bro one. */
type ReportTurn = "bro" | "phone";

/** Whether the report this turn is for still waits for it; its lease runs on. */
function renewReportTurn(
  report: ReportTurn,
  context: Parameters<typeof renewPhoneReportTurn>[0]
) {
  return report === "phone"
    ? renewPhoneReportTurn(context)
    : renewBroReportTurn(context);
}

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
 * Applied wherever the conversation may hold the files
 * (`reportTurnHoldsFiles`).
 */
function withoutFetchedUrls(message: SentMessage): SentMessage {
  if (message.kind === "message" && message.text !== undefined) {
    // A tappable word would hide where the link leads (`withVisibleLinks`).
    return withoutFetchedAttachments({
      ...message,
      text: withVisibleLinks(message.text, isSharedFileLink),
    });
  }
  return withoutFetchedAttachments(message);
}

function withoutFetchedAttachments(message: SentMessage): SentMessage {
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
 * The send without the bookkeeping in its text: `DELIVERY_COMPLETE`, which
 * the instructions ask for as plain text after the last delivery, and eve's
 * empty delivery marker. The channel fallback drops both from assistant text
 * (`fallbackDeliveryText`); written into `send_message`, the sentinel reached
 * the person as a message of its own (04.10). Nothing when neither text nor
 * an attachment is left. A text that would lose only whitespace goes out as
 * written.
 */
function withoutBookkeeping(message: SentMessage): SentMessage | undefined {
  if (message.kind === "link" || message.text === undefined) return message;
  const text = withoutEmptyDeliveryMarker(
    message.text.replaceAll(deliveryCompleteSentinel, "")
  );
  if (text.replace(/\s/gu, "") === message.text.replace(/\s/gu, "")) {
    return message;
  }
  if (text) return { ...message, text };
  if (!message.attachments) return undefined;
  const sent: Extract<SentMessage, { kind: "message" }> = {
    attachments: message.attachments,
    kind: "message",
  };
  if (message.replyTo !== undefined) sent.replyTo = message.replyTo;
  return sent;
}

/**
 * `turn` holds what the current turn already sent and did, so a repeat, a
 * rephrased status with nothing new, or a send past the per-turn limit is
 * dropped here rather than posted, and a message claiming what no tool did
 * goes back to the model. `pastAnswer` drops every send of a browser
 * report's turn past its answer (`reportPastAnswer`), and a send with only
 * bookkeeping in it is dropped as `sentinel` (`withoutBookkeeping`). A
 * message that goes out is recorded for the turn's card tools
 * (`markTurnDelivered`). In the early-reply pilot (`earlyReply`) a person's
 * turn may open with one short heads-up, and its result tells the model the
 * answer is still owed (`headsUpDeliveredNotice`). In the files pilot a
 * task file link the model miswrote is sent as the conversation's link it
 * stands for (`sharedLinks`, `withExactSharedLinks`). In the report of an
 * errand the person gave, where Bro's card may carry its options
 * (`cardsDue`, `cardTurnOpener`), a list of options goes back once to be a
 * card (`sendRefusal`).
 */
function defineSendMessage(
  turn: ReturnType<typeof turnSends>,
  pastAnswer: boolean,
  loadSkill: boolean,
  taskReport: boolean,
  earlyReply: boolean,
  report: ReportTurn | undefined,
  sharedLinks: readonly string[],
  cardsDue: boolean
) {
  return defineTool({
    description:
      "Send exactly one user-visible message to the current conversation. This is the delivery path for questions, progress updates, blockers, and final answers that need words. Choose kind message for plain text, private image artifacts, and HTTPS attachments; text and attachments may be combined. Text is delivered as written, so write it like a brief natural text message and do not use Markdown, except a link: write it as [word](https://full-address) — the word is what the person taps in Telegram and the web chat, and iMessage shows the word and the address — always with https://, and to the page of the very thing you name, never a promo, search or home page. On Telegram and iMessage attachments are downloaded and uploaded to the conversation, so the person receives real photos and files; the web chat renders them from the URL. Give the direct HTTPS URL of the file itself, such as an image URL, never a page that contains it; to send the photos from a page, call find_images with the page URL first and attach the image URLs it returns. Up to 10 attachments ride on one message and each must be about 10 MB or smaller; an attachment that cannot be downloaded falls back to a link. Set replyTo to record which message is being answered: use current for an ordinary answer, clarification, status update, or follow-up prompted by the current user message, including when the user changes topics; use task with a task ID from Eve's Task state for delayed background work; and use automation with the automation ID supplied by a scheduled report. Omit replyTo only when the message is genuinely standalone and does not answer any particular user message, such as an unsolicited announcement or proactive notice, or when no applicable handle is available. Use only handles present in the current context. Choose kind link with a URL to send a standalone native preview. Put an ordinary URL in message text when a preview is not wanted. When you list options, keep each price and fact with the option it was found for, and say «все» or «ни один» only of the options you checked. Call send_message multiple times only when you intentionally want separate messages. Call it directly without an assistant-text preamble, and do not repeat delivered content afterward.",
    inputSchema: sendMessageOutputSchema,
    execute(message, context) {
      const emit = () => {
        if (pastAnswer) return { skipped: "past" as const };
        const outgoing = withoutBookkeeping(
          withHttpsLinksInText(
            withInlineImagesAttached(
              withExactSharedLinks(
                withExactBroInviteLinks(withExactLoginHandoffLink(message)),
                sharedLinks
              )
            )
          )
        );
        if (!outgoing) return { skipped: "sentinel" as const };
        const refused = sendRefusal(outgoing, turn, earlyReply, cardsDue);
        if (refused) return refused;
        markTurnDelivered(context.session);
        // «2000 ₽» goes out as «2 000 ₽» (`amounts.ts`).
        const sent = taskReport ? withoutFetchedUrls(outgoing) : outgoing;
        return sent.kind === "message" && sent.text !== undefined
          ? { ...sent, text: withGroupedRoubles(sent.text) }
          : sent;
      };
      if (report === undefined) return emit();
      return renewReportTurn(report, context).then((current) =>
        current ? emit() : { skipped: `${report}-stale` as const }
      );
    },
    toModelOutput(output) {
      if (
        "skipped" in output &&
        (output.skipped === "phone-stale" || output.skipped === "bro-stale")
      )
        return toolOutput.text(
          `Not sent: this ${output.skipped === "phone-stale" ? "phone" : "Bro ↔ Bro"} report is stale or already delivered. End this turn silently; do not repeat, rephrase or react to it.`
        );
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
      // The same turn and verdict `execute` judged the send with.
      const headsUp =
        earlyReply &&
        message.data !== undefined &&
        opensWithHeadsUp(message.data, turn);
      return toolOutput.text(
        [
          headsUp
            ? headsUpDeliveredNotice
            : "The message was submitted to the active channel. Do not repeat or rephrase it, in assistant text or in another send_message. Send another message in this turn only with something new — a result of further work, another option, a number, a link, a question; when nothing new is left, end the turn now without calling any tool.",
          ...unsupported,
        ].join(" ")
      );
    },
  });
}

/** `![caption](https://…)`: a picture from outside written into the text. */
const inlineImagePattern = /!\[((?:\\.|[^\]\n])*)\]\((https:\/\/[^\s)]+)\)/gu;

/**
 * The send with the outside pictures its text shows as `![…](https://…)`
 * attached instead, each caption left as a line of the text. The model
 * writes found photos so, as the instructions have it for Bro's own
 * artifacts (`/artifacts/…`, which this leaves alone): on 20.10 it sent
 * Lavka's products that way twice out of two, and Telegram posts the markup
 * as «!» and a bare link. A picture past the attachment cap stays as
 * written.
 */
function withInlineImagesAttached(message: SentMessage): SentMessage {
  if (message.kind === "link" || message.text === undefined) return message;
  const attachments = [...(message.attachments ?? [])];
  let text = "";
  let from = 0;
  for (const match of message.text.matchAll(inlineImagePattern)) {
    const [markdown, caption = "", url = ""] = match;
    const attached = attachments.some((attachment) => attachment.url === url);
    if (!attached && attachments.length >= maximumMessageAttachments) continue;
    if (!attached) attachments.push({ kind: "image", url });
    text += message.text.slice(from, match.index) + caption.trim();
    from = match.index + markdown.length;
  }
  if (from === 0) return message;
  text = (text + message.text.slice(from))
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const sent: Extract<SentMessage, { kind: "message" }> = {
    attachments,
    kind: "message",
  };
  if (text) sent.text = text;
  if (message.replyTo !== undefined) sent.replyTo = message.replyTo;
  // A channel posts only what parses (an address past 2048 characters).
  return sendMessageOutputSchema.safeParse(sent).success ? sent : message;
}

/** The send with `https://` on every link address its text leaves bare. */
function withHttpsLinksInText(message: SentMessage): SentMessage {
  if (message.kind === "link" || message.text === undefined) return message;
  const text = withHttpsLinks(message.text);
  return text === message.text ? message : { ...message, text };
}

function defineReactToMessage(
  delivery: ChannelDelivery,
  pastAnswer: boolean,
  report: ReportTurn | undefined
) {
  const toggle = delivery.reactions === "toggle";
  return defineTool({
    description: toggle
      ? "Add or remove a native reaction on the user's current message. Use this instead of send_message when a reaction fully communicates a lightweight acknowledgement and words would add nothing. Supports thumbs_up, thumbs_down, heart, laugh, exclamation (emphasis), and question."
      : "Acknowledge the user's current message with one compact reaction displayed in the conversation. Use this instead of send_message when the reaction fully communicates the response and words would add nothing. Supports thumbs_up, thumbs_down, heart, laugh, exclamation (emphasis), and question.",
    inputSchema: toggle
      ? reactToMessageOutputSchema
      : addReactionToMessageOutputSchema,
    execute(reaction, context) {
      // An error result is no reaction: channels post only what parses as
      // one.
      if (pastAnswer) throw new Error(pastAnswerReaction);
      if (report === undefined) return reaction;
      return renewReportTurn(report, context).then((current) => {
        if (!current)
          throw new Error(
            `Not sent: stale or delivered ${report === "phone" ? "phone" : "Bro ↔ Bro"} reports cannot react.`
          );
        return reaction;
      });
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
    "step.started": async (event, context) => {
      const delivery = channelDelivery.get(context.channel.kind ?? "");
      const pastAnswer = reportPastAnswer(context);
      const report: ReportTurn | undefined =
        phoneReportCaller(context.session.auth.current) !== undefined
          ? "phone"
          : broReportCaller(context.session.auth.current) !== undefined
            ? "bro"
            : undefined;
      const send_message = defineSendMessage(
        turnSends(context.messages),
        pastAnswer,
        // In the skills pilot a rewrite that asks for a tool says how to
        // get one whose group is not offered yet.
        skillsLayout(context) === "core",
        // By the conversation's mark, not the files pilot alone: a report
        // carries the files' content after the flag is cleared too.
        report !== undefined ||
          (turnOpenedByBackgroundTask(context.messages) &&
            (await reportTurnHoldsFiles(context))),
        // The verdict the model's resolver got for this turn, which tells
        // the model to send the heads-up (`earlyReplyNote`).
        await earlyReplyPilotOfCaller(
          context,
          stepStartedEventSchema.safeParse(event).data
        ),
        report,
        // The links the task agent's files have in this conversation.
        taskFilesOfCaller(context) ? knownSharedLinks(context.messages) : [],
        cardsOffered(context) &&
          openedByPersonErrandReport(
            context.messages,
            context.session.auth.current
          )
      );
      const messageOnly = { send_message };
      const interactive = delivery
        ? {
            react_to_message: defineReactToMessage(
              delivery,
              pastAnswer,
              report
            ),
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
