import {
  defaultTelegramAuth,
  resolveTelegramBotToken,
  telegramChannel,
  telegramContinuationToken,
  type TelegramChannelConfig,
  type TelegramEventContext,
} from "eve/channels/telegram";
import type { SessionAuth } from "eve/context";
import { z } from "zod";
import {
  findChannelIdentity,
  redeemChannelLinkToken,
} from "@db/services/channel-identities";
import { messageQuotaGate } from "@agent/lib/billing/quota";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { resolveTelegramReplyTarget } from "@agent/lib/reply-targets";
import {
  finalizeScheduledReportDelivery,
  releaseScheduledReportDelivery,
  scheduledReportFromSession,
} from "@agent/lib/schedules/report-lifecycle";
import {
  splitTelegramHtml,
  toTelegramHtml,
} from "@agent/lib/telegram-format/html";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import {
  reactionTextFor,
  reactToMessageToolResultSchema,
} from "@shared/chat/reaction";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { env } from "@shared/environment";
import {
  imageArtifactFailureText,
  prepareImageArtifactDelivery,
} from "../lib/image-artifact/delivery";
import {
  extractImageArtifactMarkdownReferences,
  stripImageArtifactMarkdownReferences,
} from "../lib/image-artifact/markdown";

const telegramApiBaseUrl = "https://api.telegram.org";
const startLinkPattern =
  /^\/start(?:@[A-Za-z0-9_]+)?\s+link_(?<token>[\w-]+)$/u;
const unlinkedHintIntervalMs = 60 * 60_000;
const maximumThrottledChats = 500;

/**
 * eve exposes no durable channel state before a session exists, and an
 * unlinked sender never starts one, so the hint throttle lives with the
 * channel for the lifetime of the serving instance.
 */
const unlinkedHintSentAt = new Map<string, number>();

function telegramBotToken() {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "Telegram is not configured for this deployment. Set TELEGRAM_BOT_TOKEN."
    );
  }
  return botToken;
}

function telegramWebhookSecretToken() {
  const secretToken = env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  if (!secretToken) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET_TOKEN is not configured for this deployment."
    );
  }
  return secretToken;
}

// A deployment without a bot username still serves private chats; only group
// mention detection needs it, and this channel ignores groups anyway.
const botIdentity: Pick<TelegramChannelConfig, "botUsername"> =
  env.TELEGRAM_BOT_USERNAME ? { botUsername: env.TELEGRAM_BOT_USERNAME } : {};

export default telegramChannel({
  ...botIdentity,
  credentials: {
    botToken: telegramBotToken,
    webhookSecretToken: telegramWebhookSecretToken,
  },
  uploadPolicy: {
    allowedMediaTypes: ["image/*", "application/pdf"],
    maxBytes: 10 * 1024 * 1024,
  },
  events: {
    async "action.result"(event, context, session) {
      const reaction = reactToMessageToolResultSchema.safeParse(event.result);
      if (event.status === "completed" && reaction.success) {
        const messageId = currentTelegramMessageId(session.session.auth);
        if (!messageId) {
          throw new Error(
            "react_to_message requires a current Telegram message."
          );
        }
        await context.telegram.request("setMessageReaction", {
          chat_id: context.telegram.chatId,
          message_id: Number(messageId),
          reaction:
            reaction.data.output.operation === "remove"
              ? []
              : [
                  {
                    emoji: reactionTextFor(reaction.data.output.type),
                    type: "emoji",
                  },
                ],
        });
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const message = sendMessageToolResultSchema.safeParse(event.result);
      if (event.status !== "completed" || !message.success) return;

      const { output } = message.data;
      // Telegram can quote a message natively, but send_message advertises
      // unquoted delivery on this channel, so a handle is only validated to
      // keep the conversation check the tool result describes.
      if (
        output.replyTo &&
        !resolveTelegramReplyTarget(output.replyTo, session.session.auth)
      ) {
        console.warn(
          "[telegram] reply handle is not part of this conversation",
          {
            sessionId: session.session.id,
          }
        );
      }

      if (output.kind === "link") {
        await sendText(context, output.url);
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const attachmentLinks = (output.attachments ?? []).map(
        (attachment) => attachment.url
      );
      const requestedText = output.text;
      if (!requestedText) {
        if (attachmentLinks.length > 0) {
          await sendText(context, attachmentLinks.join("\n"));
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
        await sendText(context, [text, ...attachmentLinks].join("\n\n"));
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const report = scheduledReportFromSession(session);
      const delivery = await prepareImageArtifactDelivery(requestedText, {
        rootSessionId: report?.workerSessionId ?? session.session.id,
        scope: scopeFromPrincipal(caller),
      });
      if (delivery.failedArtifactIds.length > 0) {
        console.warn("[telegram] image artifact delivery failed", {
          artifactIds: delivery.failedArtifactIds,
          sessionId: session.session.id,
        });
      }
      const failureMessage = imageArtifactFailureText(
        delivery.failedArtifactIds.length
      );
      const body = [delivery.text, failureMessage, ...attachmentLinks]
        .filter(Boolean)
        .join("\n\n");
      if (body) await sendText(context, body);
      for (const file of delivery.files) {
        // Photos are uploaded one at a time so a single failure cannot drop
        // the rest of the delivery.
        // oxlint-disable-next-line eslint/no-await-in-loop -- Telegram renders uploads in call order.
        await sendPhoto(context, file);
      }
      await finalizeScheduledReportDelivery(session);
    },
    // Overriding eve's default reply handler keeps assistant text out of the
    // chat: send_message above is the only delivery path on this channel.
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
    async "turn.failed"(event, context, session) {
      await releaseScheduledReportDelivery(session, event.message);
      // A failed reporting turn is retried from its lease, so only a person
      // waiting on their own message is told that the turn broke.
      if (!scheduledReportFromSession(session)) {
        await sendText(
          context,
          "Что-то сломалось, пока я разбирался с твоей просьбой. Попробуй ещё раз."
        );
      }
    },
  },
  async onMessage(context, message) {
    // Only private chats carry a single identifiable person, which is what an
    // account binding means here. Groups are dropped without a reply.
    if (message.chat.type !== "private") return null;
    const from = message.from;
    if (!from || from.isBot) return null;

    const token = startLinkPattern.exec(message.text || message.caption)?.groups
      ?.token;
    if (token) {
      const outcome = await redeemChannelLinkToken("telegram", token, {
        chatId: message.chat.id,
        externalUserId: from.id,
        username: from.username,
      });
      await context.telegram.sendMessage(linkOutcomeText(outcome));
      return null;
    }

    const identity = await findChannelIdentity("telegram", from.id);
    if (!identity) {
      if (shouldSendUnlinkedHint(message.chat.id)) {
        await context.telegram.sendMessage(unlinkedHintText);
      }
      return null;
    }

    const auth = defaultTelegramAuth(message);
    if (!auth) return null;
    const principalId = `better-auth:${identity.userId}`;
    const scope = accessScopeForUser(principalId);
    // Metering happens before the turn starts, so an over-limit message costs
    // a counter row rather than a model call.
    const gate = await messageQuotaGate(scope);
    if (!gate.allowed) {
      if (gate.paywallText) {
        await context.telegram.sendMessage(gate.paywallText);
      }
      return null;
    }
    return {
      auth: {
        ...auth,
        attributes: {
          ...auth.attributes,
          conversationChannel: "telegram",
          conversationId: telegramContinuationToken({
            chatId: message.chat.id,
          }),
          telegramChatId: message.chat.id,
          telegramMessageId: message.messageId,
          telegramUserId: from.id,
          workspaceId: scope.workspaceId,
        },
        principalId,
      },
    };
  },
});

const unlinkedHintText = [
  "Этот телеграм пока не привязан ни к одному кабинету.",
  "",
  "Открой кабинет в браузере и нажми «Привязать Telegram» или попроси меня в iMessage привязать телеграм. И там, и там получится одноразовая ссылка, которая свяжет этот чат с твоим аккаунтом.",
].join("\n");

function linkOutcomeText(
  outcome: Awaited<ReturnType<typeof redeemChannelLinkToken>>
) {
  switch (outcome) {
    case "linked": {
      return "Готово, телеграм привязан. Пиши мне прямо здесь.";
    }
    case "expired": {
      return "Ссылка протухла: они живут 30 минут. Сделай новую и попробуй ещё раз.";
    }
    case "already_linked_other_user": {
      return "Этот телеграм уже привязан к другому кабинету. Сначала отвяжи его там.";
    }
    case "already_linked_other_account": {
      return "К тому кабинету уже привязан другой телеграм. Сначала отвяжи тот.";
    }
    default: {
      return "Ссылка не подходит. Возможно, ею уже воспользовались — сделай новую.";
    }
  }
}

function shouldSendUnlinkedHint(chatId: string, now = Date.now()) {
  const sentAt = unlinkedHintSentAt.get(chatId);
  if (sentAt !== undefined && now - sentAt < unlinkedHintIntervalMs) {
    return false;
  }
  if (unlinkedHintSentAt.size >= maximumThrottledChats) {
    for (const [chat, at] of unlinkedHintSentAt) {
      if (now - at >= unlinkedHintIntervalMs) unlinkedHintSentAt.delete(chat);
    }
  }
  unlinkedHintSentAt.set(chatId, now);
  return true;
}

const telegramMessageIdSchema = z.string().min(1);

function currentTelegramMessageId(auth: SessionAuth) {
  const messageId = telegramMessageIdSchema.safeParse(
    auth.current?.attributes.telegramMessageId
  );
  return messageId.success ? messageId.data : undefined;
}

async function sendText(context: TelegramEventContext, text: string) {
  if (!context.telegram.chatId) return;
  for (const chunk of splitTelegramHtml(toTelegramHtml(text))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Telegram renders split messages in call order.
    await context.telegram.request("sendMessage", {
      chat_id: context.telegram.chatId,
      parse_mode: "HTML",
      text: chunk,
    });
  }
}

/**
 * eve's Telegram handle only speaks JSON, so an image artifact is uploaded
 * with a multipart `sendPhoto` call against the Bot API directly.
 */
async function sendPhoto(
  context: TelegramEventContext,
  file: {
    readonly data: Buffer;
    readonly filename: string;
    readonly mimeType: string;
  }
) {
  try {
    const botToken = await resolveTelegramBotToken(telegramBotToken);
    const form = new FormData();
    form.set("chat_id", context.telegram.chatId);
    form.set(
      "photo",
      new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
      file.filename
    );
    const response = await fetch(
      `${telegramApiBaseUrl}/bot${botToken}/sendPhoto`,
      { body: form, method: "POST" }
    );
    if (!response.ok) {
      throw new Error(
        `Telegram sendPhoto failed (${String(response.status)}).`
      );
    }
  } catch (error) {
    console.warn("[telegram] photo upload failed", {
      cause: error,
      filename: file.filename,
    });
  }
}
