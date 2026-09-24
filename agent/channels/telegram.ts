import {
  defaultTelegramAuth,
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  resolveTelegramBotToken,
  telegramChannel,
  telegramContinuationToken,
  type TelegramChannelConfig,
  type TelegramEventContext,
} from "eve/channels/telegram";
import type { SessionAuth, SessionContext } from "eve/context";
import { z } from "zod";
import {
  findChannelIdentity,
  redeemChannelLinkToken,
} from "@db/services/channel-identities";
import { messageQuotaGate } from "@agent/lib/billing/quota";
import {
  fallbackDeliveryText,
  replyLanguageFor,
  sessionReplyLanguage,
  turnFailureNotice,
} from "@agent/lib/delivery/fallback";
import { withApprovalCard } from "@shared/chat/approval-card";
import { firstContactContext } from "@agent/lib/first-contact";
import { telegramMediaTurn } from "@agent/lib/inbound-media/telegram";
import {
  prepareAttachmentDelivery,
  type OutboundFile,
} from "@agent/lib/outbound-media/attachments";
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
import {
  sendMessageToolResultSchema,
  type MessageAttachment,
} from "@shared/chat/message-delivery";
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
/** The Bot API method and form field that uploads each kind of file. */
const telegramUploads = {
  audio: { field: "audio", method: "sendAudio" },
  document: { field: "document", method: "sendDocument" },
  photo: { field: "photo", method: "sendPhoto" },
  video: { field: "video", method: "sendVideo" },
} as const satisfies Record<
  OutboundFile["kind"],
  { readonly field: string; readonly method: string }
>;
/** Photos and videos ride in one album only between these counts. */
const albumSizeRange = { maximum: 10, minimum: 2 } as const;
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
        markTurnDelivered(context, event.turnId);
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
        markTurnDelivered(context, event.turnId);
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const attachments = output.attachments ?? [];
      const requestedText = output.text;
      if (!requestedText) {
        const prepared = await attachmentDelivery(session, attachments);
        await uploadFiles(context, prepared.files, prepared.links);
        markTurnDelivered(context, event.turnId);
        await finalizeScheduledReportDelivery(session);
        return;
      }

      await deliverText(context, session, {
        attachments,
        text: requestedText,
      });
      markTurnDelivered(context, event.turnId);
      await finalizeScheduledReportDelivery(session);
    },
    // eve's default reply handler would post every assistant message, so this
    // channel delivers through send_message instead. A model that answers in
    // plain text anyway would leave the person with silence, so the text of
    // such a turn is delivered here as a fallback.
    async "message.completed"(event, context, session) {
      if (event.finishReason === "tool-calls") return;
      const report = scheduledReportFromSession(session);
      if (report) {
        await finalizeScheduledReportDelivery(session, "suppressed");
        return;
      }
      if (deliveredTurnId(context) === event.turnId) return;
      const text = fallbackDeliveryText(event.message);
      if (!text) return;
      console.warn("[telegram] assistant text delivered as fallback", {
        sessionId: session.session.id,
      });
      markTurnDelivered(context, event.turnId);
      await deliverText(context, session, { attachments: [], text });
    },
    // eve's own card, except that an approval says what it lets through — a
    // browser errand's submission, a standing permission, a spend limit —
    // instead of only the tool's name.
    async "input.requested"(event, context, session) {
      const language = sessionReplyLanguage(session.session.auth);
      /* oxlint-disable eslint/no-await-in-loop -- Each card is posted in request order, and a freeform prompt is registered against its own message. */
      for (const request of event.requests) {
        const rendered = renderTelegramInputRequest(
          withApprovalCard(request, language),
          context.state
        );
        const posted = await context.telegram.post({
          reply_markup: rendered.replyMarkup,
          text: rendered.text,
        });
        if (rendered.freeformRequestId !== undefined && posted.id) {
          registerTelegramFreeformPrompt(context.state, {
            messageId: posted.id,
            requestId: rendered.freeformRequestId,
          });
        }
      }
      /* oxlint-enable eslint/no-await-in-loop */
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
          turnFailureNotice(event, sessionReplyLanguage(session.session.auth))
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
    const sessionAuth = {
      ...auth,
      attributes: {
        ...auth.attributes,
        conversationChannel: "telegram",
        conversationId: telegramContinuationToken({
          chatId: message.chat.id,
        }),
        replyLanguage: replyLanguageFor(message.text || message.caption),
        telegramChatId: message.chat.id,
        telegramMessageId: message.messageId,
        telegramUserId: from.id,
        workspaceId: scope.workspaceId,
      },
      principalId,
    };
    // Photos, documents and voice notes are resolved to bytes and text here,
    // because eve's lazy resolver drops a photo the Bot API serves without an
    // image content type and never reads a voice note at all.
    const media = await telegramMediaTurn(message);
    if (media?.notice) await context.telegram.sendMessage(media.notice);
    // A voice note nobody could transcribe leaves nothing to answer, so the
    // retry line above is the whole reply and no model turn starts.
    if (media !== undefined && media.message === undefined) return null;
    // An account linked from the web cabinet may never have written before,
    // so the introduction follows the workspace's first message here too. It
    // is claimed only now, once this message is sure to start a turn.
    const turnContext = await firstContactContext(scope);
    if (media === undefined) return { auth: sessionAuth, context: turnContext };
    return { auth: sessionAuth, context: turnContext, message: media.message };
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

/**
 * Downloads what `send_message` attached so it can be uploaded as real media.
 * An attachment that could not be fetched keeps the old behaviour and travels
 * as a link, and the reason is logged without the URL.
 */
async function attachmentDelivery(
  session: SessionContext,
  attachments: readonly MessageAttachment[]
) {
  const prepared = await prepareAttachmentDelivery(attachments);
  if (prepared.failures.length > 0) {
    console.warn("[telegram] attachment delivery failed", {
      reasons: prepared.failures.map((failure) => failure.reason),
      sessionId: session.session.id,
    });
  }
  return {
    files: prepared.files,
    links: prepared.failures.map((failure) => failure.url),
  };
}

/**
 * Delivers one reply body: the words go out as Telegram HTML first, then the
 * image artifacts referenced in the text and the attachments `send_message`
 * asked for are uploaded as media. Both `send_message` and the plain-text
 * fallback deliver through here.
 */
async function deliverText(
  context: TelegramEventContext,
  session: SessionContext,
  {
    attachments,
    text,
  }: {
    readonly attachments: readonly MessageAttachment[];
    readonly text: string;
  }
) {
  const caller = session.session.auth.current ?? session.session.auth.initiator;
  if (!caller) {
    const references = extractImageArtifactMarkdownReferences(text);
    const body =
      references.length === 0
        ? text
        : [
            stripImageArtifactMarkdownReferences(text),
            imageArtifactFailureText(references.length),
          ]
            .filter(Boolean)
            .join("\n\n");
    if (body) await sendText(context, body);
    const prepared = await attachmentDelivery(session, attachments);
    await uploadFiles(context, prepared.files, prepared.links);
    return;
  }

  const report = scheduledReportFromSession(session);
  const delivery = await prepareImageArtifactDelivery(text, {
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
  const body = [delivery.text, failureMessage].filter(Boolean).join("\n\n");
  // The words are worth reading before the pictures arrive, so nothing waits
  // on a download that may take the whole timeout.
  if (body) await sendText(context, body);
  const prepared = await attachmentDelivery(session, attachments);
  await uploadFiles(
    context,
    // An artifact has no public URL, so a failed upload has no link to fall
    // back to.
    [...delivery.files, ...prepared.files],
    prepared.links
  );
}

/**
 * The turn whose reply already went out through a tool, kept in the channel
 * state eve persists between the events of one turn, so `message.completed`
 * can tell a delivered turn from one the model answered in plain text.
 */
function deliveryMarker(context: TelegramEventContext) {
  // SAFETY: The marker rides along with eve's own Telegram state, which is a
  // closed interface but a plain JSON object eve round-trips verbatim.
  return context.state as TelegramEventContext["state"] & {
    deliveredTurnId?: string;
  };
}

function markTurnDelivered(context: TelegramEventContext, turnId: string) {
  deliveryMarker(context).deliveredTurnId = turnId;
}

function deliveredTurnId(context: TelegramEventContext) {
  return deliveryMarker(context).deliveredTurnId;
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
 * Uploads every file of one reply and posts whatever is left as links. Photos
 * and videos ride in albums of up to ten so Telegram shows them as galleries;
 * anything else is uploaded on its own. A file that cannot be uploaded at all
 * falls back to its source link.
 */
async function uploadFiles(
  context: TelegramEventContext,
  files: readonly OutboundFile[],
  links: readonly string[]
) {
  const undelivered = [...links];
  if (files.length > 0) {
    if (context.telegram.chatId) {
      undelivered.push(...(await uploadMedia(context, files)));
    } else {
      console.warn("[telegram] upload skipped without a chat", {
        files: files.length,
      });
    }
  }
  if (undelivered.length > 0) {
    await sendText(context, undelivered.join("\n"));
  }
}

/** The source links of the files this reply could not upload. */
/* oxlint-disable eslint/no-await-in-loop -- Telegram renders uploads in call order. */
async function uploadMedia(
  context: TelegramEventContext,
  files: readonly OutboundFile[]
) {
  const undelivered: string[] = [];
  const separate = files.filter((file) => !isAlbumFile(file));
  const individual: OutboundFile[] = [];
  for (const album of albums(files.filter((file) => isAlbumFile(file)))) {
    if (album.length < albumSizeRange.minimum) {
      individual.push(...album);
      continue;
    }
    const outcome = await sendAlbum(context, album);
    if (outcome === "sent") continue;
    if (outcome === "retry-individually") {
      individual.push(...album);
      continue;
    }
    undelivered.push(...sourceLinks(album));
  }
  // Documents and audio follow the galleries they were sent with.
  for (const file of [...individual, ...separate]) {
    const sent = await sendFile(context, file);
    if (!sent && file.sourceUrl) undelivered.push(file.sourceUrl);
  }
  return undelivered;
}
/* oxlint-enable eslint/no-await-in-loop */

function* albums(files: readonly OutboundFile[]) {
  for (let start = 0; start < files.length; start += albumSizeRange.maximum) {
    yield files.slice(start, start + albumSizeRange.maximum);
  }
}

function sourceLinks(files: readonly OutboundFile[]) {
  return files.flatMap((file) => file.sourceUrl ?? []);
}

function isAlbumFile(file: OutboundFile) {
  return file.kind === "photo" || file.kind === "video";
}

/**
 * Uploads one file, retrying as a plain document when Telegram rejected the
 * request itself: a photo past its dimension or ratio limits comes back as a
 * 400 that the same bytes survive as a document. A refused, throttled or
 * broken request is not worth a second upload of the same megabytes.
 */
async function sendFile(context: TelegramEventContext, file: OutboundFile) {
  try {
    await uploadFile(context, file);
    return true;
  } catch (error) {
    console.warn("[telegram] file upload failed", {
      cause: error,
      filename: file.filename,
    });
    // Telegram rejected the request itself rather than failing to serve it.
    const rejected = error instanceof TelegramApiError && error.status === 400;
    if (file.kind === "document" || !rejected) return false;
  }
  try {
    await uploadFile(context, { ...file, kind: "document" });
    return true;
  } catch (error) {
    console.warn("[telegram] file upload failed", {
      cause: error,
      filename: file.filename,
    });
    return false;
  }
}

async function uploadFile(context: TelegramEventContext, file: OutboundFile) {
  const { field, method } = telegramUploads[file.kind];
  const form = new FormData();
  form.set("chat_id", context.telegram.chatId);
  form.set(field, fileBlob(file), file.filename);
  await callBotApi(method, form);
}

/**
 * Posts photos and videos as the one gallery Telegram calls a media group.
 * A rejected group is worth retrying file by file, because one picture
 * Telegram dislikes fails the whole call; anything else is not.
 */
async function sendAlbum(
  context: TelegramEventContext,
  files: readonly OutboundFile[]
) {
  const form = new FormData();
  form.set("chat_id", context.telegram.chatId);
  form.set(
    "media",
    JSON.stringify(
      files.map((file, index) => ({
        media: `attach://file${String(index)}`,
        type: file.kind,
      }))
    )
  );
  for (const [index, file] of files.entries()) {
    form.set(`file${String(index)}`, fileBlob(file), file.filename);
  }
  try {
    await callBotApi("sendMediaGroup", form);
    return "sent";
  } catch (error) {
    console.warn("[telegram] album upload failed", {
      cause: error,
      files: files.length,
    });
    const rejected = error instanceof TelegramApiError && error.status === 400;
    return rejected ? "retry-individually" : "failed";
  }
}

function fileBlob(file: OutboundFile) {
  // A `Buffer` is typed over `ArrayBufferLike`, which `BlobPart` does not
  // accept, so the upload pays for one copy of the bytes it is about to send.
  return new Blob([new Uint8Array(file.data)], { type: file.mimeType });
}

/** A Bot API call the server answered with an error, and the status it used. */
class TelegramApiError extends Error {
  readonly status: number;

  constructor(method: string, status: number, description: string | undefined) {
    const detail = description ? `: ${description}` : "";
    super(`Telegram ${method} failed (${String(status)})${detail}.`);
    this.name = "TelegramApiError";
    this.status = status;
  }
}

const telegramErrorSchema = z.object({ description: z.string().min(1) });

/**
 * eve's Telegram handle only speaks JSON, so an upload is a multipart call
 * against the Bot API directly.
 */
async function callBotApi(method: string, form: FormData) {
  const botToken = await resolveTelegramBotToken(telegramBotToken);
  const response = await fetch(
    `${telegramApiBaseUrl}/bot${botToken}/${method}`,
    { body: form, method: "POST" }
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new TelegramApiError(
      method,
      response.status,
      telegramErrorSchema.safeParse(body).data?.description
    );
  }
}
