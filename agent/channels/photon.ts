import type { AdapterPostableMessage, Thread } from "chat";
import {
  defaultPhotonAuth,
  photonIMessageChannel,
  type PhotonIMessageChannelConfig,
} from "eve/channels/photon";
import { z } from "zod";
import { resolvePhotonReplyTarget } from "@agent/lib/reply-targets";
import { messageQuotaGate } from "@agent/lib/billing/quota";
import { photonMediaTurn } from "@agent/lib/inbound-media/photon";
import { voiceFailedNote } from "@agent/lib/inbound-media/turn-content";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { ensureVerifiedPhoneUser } from "@db/services/auth/phone-user";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { reactToMessageToolResultSchema } from "@shared/chat/reaction";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { normalizeAuthPhoneNumber } from "@shared/identity/phone-number";
import { photonProjectCredentials } from "@shared/photon/credentials";
import { env } from "@shared/environment";
import {
  imageArtifactFailureText,
  prepareImageArtifactDelivery,
} from "../lib/image-artifact/delivery";
import { toIMessageBubbles } from "../lib/imessage-text/bubbles";
import { toIMessageText } from "../lib/imessage-text/compile";
import {
  extractImageArtifactMarkdownReferences,
  stripImageArtifactMarkdownReferences,
} from "../lib/image-artifact/markdown";
import {
  finalizeScheduledReportDelivery,
  releaseScheduledReportDelivery,
  scheduledReportFromSession,
} from "@agent/lib/schedules/report-lifecycle";

const webhookSecret = env.IMESSAGE_WEBHOOK_SECRET;

/**
 * Handed to the model on the turn that created the account. The instructions
 * look for the `first-contact` marker and introduce Bro once, in Russian.
 */
const firstContactContext =
  "Пометка `first-contact`: аккаунт этого человека создан прямо сейчас, это его первое в жизни сообщение, и знакомства ещё не было.";

// Photon signs its own webhook deliveries. Without the signing secret nothing
// can be verified, so reject the delivery with the missing configuration.
const webhookVerification: Pick<
  PhotonIMessageChannelConfig,
  "webhookSecret" | "webhookVerifier"
> = webhookSecret
  ? { webhookSecret }
  : {
      webhookVerifier() {
        throw new Error(
          "IMESSAGE_WEBHOOK_SECRET is not configured for this deployment."
        );
      },
    };

export default photonIMessageChannel({
  credentials: photonProjectCredentials,
  ...webhookVerification,
  events: {
    async "action.result"(event, context, session) {
      const reaction = reactToMessageToolResultSchema.safeParse(event.result);
      if (event.status === "completed" && reaction.success) {
        if (!context.thread) {
          throw new Error(
            "react_to_message requires an active iMessage conversation thread."
          );
        }
        const messageId = context.thread.toJSON().currentMessage?.id;
        if (!messageId) {
          throw new Error(
            "react_to_message requires a current iMessage message."
          );
        }
        const adapter = context.bot.getAdapter("imessage");
        if (reaction.data.output.operation === "remove") {
          await adapter.removeReaction(
            context.thread.id,
            messageId,
            reaction.data.output.type
          );
        } else {
          await adapter.addReaction(
            context.thread.id,
            messageId,
            reaction.data.output.type
          );
        }
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const message = sendMessageToolResultSchema.safeParse(event.result);
      if (event.status !== "completed" || !message.success) return;

      const { thread } = context;
      if (!thread) {
        throw new Error(
          "send_message requires an active iMessage conversation thread."
        );
      }
      const { output } = message.data;
      // Photon posts into a conversation without a reply anchor, so a resolved
      // handle cannot become a native quoted reply. Resolving it still keeps
      // the conversation check, and the tool result tells the model that this
      // channel delivers every message unquoted.
      if (
        output.replyTo &&
        !resolvePhotonReplyTarget(output.replyTo, session.session.auth)
      ) {
        console.warn("[photon] reply handle is not part of this conversation", {
          sessionId: session.session.id,
        });
      }

      if (output.kind === "link") {
        // A message whose whole body is a URL renders as a native iMessage
        // rich link preview, which is the closest Photon gets to a link card.
        await thread.post({ raw: output.url });
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const attachmentLinks = (output.attachments ?? []).map(
        (attachment) => attachment.url
      );
      const requestedText = output.text;
      if (!requestedText) {
        if (attachmentLinks.length > 0) {
          await thread.post({ raw: attachmentLinks.join("\n") });
        }
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const caller =
        session.session.auth.current ?? session.session.auth.initiator;
      if (!caller) {
        const references =
          extractImageArtifactMarkdownReferences(requestedText);
        const text =
          references.length === 0
            ? requestedText
            : [
                stripImageArtifactMarkdownReferences(requestedText),
                imageArtifactFailureText(references.length),
              ]
                .filter(Boolean)
                .join("\n\n");
        await postBubbles(thread, { attachmentLinks, files: [], text });
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const report = scheduledReportFromSession(session);
      const delivery = await prepareImageArtifactDelivery(requestedText, {
        rootSessionId: report?.workerSessionId ?? session.session.id,
        scope: scopeFromPrincipal(caller),
      });
      if (delivery.failedArtifactIds.length > 0) {
        console.warn("[photon] browser image delivery failed", {
          artifactIds: delivery.failedArtifactIds,
          sessionId: session.session.id,
        });
      }
      const failureMessage = imageArtifactFailureText(
        delivery.failedArtifactIds.length
      );
      await postBubbles(thread, {
        attachmentLinks,
        files: delivery.files,
        text: [delivery.text, failureMessage].filter(Boolean).join("\n\n"),
      });
      await finalizeScheduledReportDelivery(session);
    },
    async "message.completed"(event, _context, session) {
      if (event.finishReason === "tool-calls") return;
      const report = scheduledReportFromSession(session);
      if (report) {
        await finalizeScheduledReportDelivery(session, "suppressed");
      }
    },
    async "session.completed"(_event, _context, session) {
      const report = scheduledReportFromSession(session);
      if (report) {
        await finalizeScheduledReportDelivery(session, "suppressed");
      }
    },
    async "turn.cancelled"(_event, _context, session) {
      await releaseScheduledReportDelivery(
        session,
        "Scheduled result reporting was cancelled."
      );
    },
    async "turn.failed"(event, _context, session) {
      await releaseScheduledReportDelivery(session, event.message);
    },
  },
  async onMessage(context, message) {
    if (message.author.isBot || message.author.isMe) return null;

    const auth = defaultPhotonAuth(message);
    const phoneNumber = normalizeAuthPhoneNumber(message.author.userName);
    if (!phoneNumber) {
      // Photon delivers group chats and email handles too. Only a phone number
      // can be matched to an account, so anything else is unauthenticated.
      console.warn("[photon] ignoring message from a non-phone handle", {
        threadId: context.thread.id,
      });
      return null;
    }
    // Photon proved possession of this number by delivering the message, which
    // is the same factor the sign-in code checks, so a first-time number is
    // onboarded here instead of being dropped.
    const account = await ensureVerifiedPhoneUser(phoneNumber);
    if (!account) {
      console.warn("[photon] ignoring message from an unusable handle", {
        threadId: context.thread.id,
      });
      return null;
    }
    const principalId = `better-auth:${account.userId}`;
    const scope = accessScopeForUser(principalId);
    // Metering happens before the turn starts, so an over-limit message costs
    // a counter row rather than a model call.
    const gate = await messageQuotaGate(scope);
    if (!gate.allowed) {
      if (gate.paywallText) {
        await context.thread.post({ raw: gate.paywallText });
      }
      return null;
    }
    const sessionAuth = {
      ...auth,
      attributes: {
        ...auth.attributes,
        conversationChannel: "photon",
        conversationId: context.thread.id,
        phoneNumber,
        photonMessageId: message.id,
        photonThreadId: context.thread.id,
        workspaceId: scope.workspaceId,
      },
      principalId,
    };
    // The account was created by this very message, so the turn is the first
    // one this person ever had and the instructions introduce Bro once.
    const turnContext = account.created ? [firstContactContext] : [];
    // Photos and voice notes are read from the Photon message here, because
    // the adapter exposes no URL for them and the model otherwise sees nothing.
    const media = await photonMediaTurn(message);
    if (media === undefined) return { auth: sessionAuth, context: turnContext };
    if (media.notice) await context.thread.post({ raw: media.notice });
    if (media.message === undefined) {
      // A first message that is an unusable voice note still gets its turn:
      // the first-contact introduction happens only on the turn that created
      // the account, and the model can ask the person to type instead.
      if (account.created) {
        return {
          auth: sessionAuth,
          context: turnContext,
          message: voiceFailedNote,
        };
      }
      // Otherwise the retry line above is the whole reply, no model turn
      // starts, and eve does not get to mark the message read.
      await markReadBestEffort(context.thread, message.id);
      return null;
    }
    return { auth: sessionAuth, context: turnContext, message: media.message };
  },
});

/** The iMessage adapter's read receipt, which the base Chat SDK adapter does not declare. */
const readReceiptSchema = z.object({
  markRead: z.function({
    input: [z.string(), z.string()],
    output: z.promise(z.void()),
  }),
});

/** Marks the message read the way eve does for a message that starts a turn. */
async function markReadBestEffort(thread: Thread, messageId: string) {
  const receipt = readReceiptSchema.safeParse(thread.adapter);
  if (!receipt.success) return;
  try {
    // The parsed wrapper does not carry the adapter as `this`.
    await receipt.data.markRead.call(thread.adapter, thread.id, messageId);
  } catch {
    // The reply was already posted; a missing read receipt is not worth a retry.
  }
}

/**
 * Photon delivers one bubble per post, so a long numbered dump goes out as the
 * bubbles a person would have typed rather than one wall of text. Attachments
 * ride with the last bubble, which keeps them below the words that introduce
 * them.
 */
async function postBubbles(
  thread: Thread,
  {
    attachmentLinks,
    files,
    text,
  }: {
    readonly attachmentLinks: readonly string[];
    readonly files: readonly {
      readonly data: Buffer;
      readonly filename: string;
      readonly mimeType: string;
    }[];
    readonly text: string;
  }
) {
  const bubbles = toIMessageBubbles(text);
  // A message the splitter declines to break up is still delivered whole:
  // dropping it would lose the only user-visible output of the turn.
  const delivered =
    bubbles.length > 0 ? bubbles : [toIMessageText(text)].filter(Boolean);
  const last = delivered.at(-1);
  for (const bubble of delivered.slice(0, -1)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- iMessage renders bubbles in post order.
    await thread.post({ raw: bubble });
  }
  if (
    last === undefined &&
    attachmentLinks.length === 0 &&
    files.length === 0
  ) {
    return;
  }
  await thread.post(
    outgoingMessage({ attachmentLinks, files, text: last ?? "" })
  );
}

function outgoingMessage({
  attachmentLinks,
  files,
  text,
}: {
  readonly attachmentLinks: readonly string[];
  readonly files: readonly {
    readonly data: Buffer;
    readonly filename: string;
    readonly mimeType: string;
  }[];
  readonly text: string;
}) {
  // Photon uploads message files but ignores attachments referenced by URL, so
  // a requested attachment is delivered as a link the recipient can open.
  const body = [text, ...attachmentLinks].filter(Boolean).join("\n\n");
  const outgoing: Extract<AdapterPostableMessage, { raw: string }> = {
    raw: body,
  };
  if (files.length > 0) outgoing.files = [...files];
  return outgoing;
}
