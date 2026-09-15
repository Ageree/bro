import { defineChannel, POST } from "eve/channels";
import {
  attachCabinetLogin,
  bindTelegram,
  getTenantByTelegram,
  loadWakeContext,
  mintTelegramBind,
  touchLastChannel,
} from "../lib/convex";
import { prefetchInstinctRecall } from "../lib/instinct-recall.ts";
import { prefetchOpenRouter } from "../lib/openrouter-warm.ts";
import {
  cabinetBaseUrl,
  helpText,
  isHelpAsk,
  isTelegramAsk,
  shouldSkipAgentTurn,
} from "../lib/onboard-policy";
import { storedHandle } from "../../convex/lib/cabinetPolicy";
import { chatConversationId } from "../lib/tenant";
import {
  assembleInboundContent,
  prefetchInboundImages,
} from "../lib/inbound-image.ts";
import { saveTelegramInboundFiles } from "../lib/inbound-files.ts";
import { transcribeVoiceNote } from "../lib/voice";
import { inboundVoiceLine } from "../lib/imessage-text";
import { VOICE_FAILED_REPLY } from "../lib/voice-policy";
import { inboundOwnerGate } from "./imessage.ts";
import {
  bindRefuseText,
  telegramBindLink,
  telegramWelcomeText,
  parseTelegramStart,
} from "../../convex/lib/telegramPolicy.ts";
import {
  answerCallback,
  isPrivateChat,
  largestPhoto,
  sendTelegramMessage,
  sendTelegramTyping,
  telegramBotUsername,
  telegramFileUrl,
  webhookSecretOk,
  type TelegramMessage,
  type TelegramUpdate,
} from "../lib/telegram";
import { compileTelegram } from "../lib/telegram-text.ts";
import { parkTurn } from "../lib/channel-turn.ts";
import { deliverHumanRouted } from "../lib/deliver-routed.ts";
import { inboundAtAttribute } from "../lib/latency-log.ts";
import { parkLastChannelTouch } from "../lib/early-deliver.ts";
import { shortAckAttribute } from "../lib/short-ack.ts";
import {
  fastAckAttribute,
  fastAckBudgetMs,
  settleFastAck,
  startFastAck,
} from "../lib/fast-ack.ts";
import { cloudInjectAttribute } from "../../convex/lib/browserInjectPolicy.ts";

function telegramAuthAttrs(opts: {
  conversationId: string;
  telegramChatId: string;
  telegramUserId: string;
  messageId: string;
  inkboxHandle?: string;
  text?: string;
  receivedAt?: number;
  fastAck?: string | null;
}): Record<string, string> {
  return {
    conversationId: opts.conversationId,
    telegramChatId: opts.telegramChatId,
    telegramUserId: opts.telegramUserId,
    messageId: opts.messageId,
    origin: "human",
    channel: "telegram",
    ...(opts.inkboxHandle ? { inkboxHandle: opts.inkboxHandle } : {}),
    ...shortAckAttribute(opts.text ?? ""),
    ...inboundAtAttribute(opts.receivedAt ?? Date.now()),
    ...fastAckAttribute(opts.fastAck ?? null),
    ...cloudInjectAttribute(opts.text ?? ""),
  };
}

function chatIdOf(msg: TelegramMessage): string {
  return String(msg.chat.id);
}

function userIdOf(msg: TelegramMessage): string | undefined {
  const id = msg.from?.id;
  return typeof id === "number" ? String(id) : undefined;
}

async function sendHtml(chatId: string, markdown: string): Promise<void> {
  const compiled = compileTelegram(markdown);
  const html = compiled.chunks[0] ?? compiled.html;
  if (!html) return;
  await sendTelegramMessage({
    chatId,
    html,
    buttons: compiled.buttons,
  });
}

async function inboundTelegramText(
  msg: TelegramMessage,
): Promise<{ text: string; voice: boolean; allVoiceFailed: boolean }> {
  const caption = (msg.text ?? msg.caption ?? "").trim();
  const voice = msg.voice ?? msg.audio;
  if (voice) {
    try {
      const url = await telegramFileUrl(voice.file_id);
      const result = await transcribeVoiceNote({
        url,
        contentType: voice.mime_type ?? "audio/ogg",
        size: voice.file_size ?? null,
      });
      if (result.ok && result.text.trim()) {
        return {
          text: [inboundVoiceLine({ content: result.text }), caption]
            .filter(Boolean)
            .join("\n"),
          voice: true,
          allVoiceFailed: false,
        };
      }
    } catch (err) {
      console.error("telegram voice failed", err);
    }
    if (!caption) {
      return { text: "", voice: true, allVoiceFailed: true };
    }
  }
  return { text: caption, voice: Boolean(voice), allVoiceFailed: false };
}

async function inboundTelegramPhotoParts(msg: TelegramMessage) {
  const photo = largestPhoto(msg);
  if (!photo) return [];
  try {
    const url = await telegramFileUrl(photo.file_id);
    return await prefetchInboundImages([
      {
        url,
        content_type: "image/jpeg",
        size: photo.file_size ?? null,
      },
    ]);
  } catch (err) {
    console.error("telegram photo fetch failed", err);
    return [];
  }
}

export default defineChannel({
  turnPolicy: "steer",
  routes: [
    POST("/webhooks/telegram", async (request, { from, waitUntil }) => {
      const receivedAt = Date.now();
      if (!webhookSecretOk(request)) {
        return new Response("unauthorized", { status: 401 });
      }
      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch {
        return new Response("bad json", { status: 400 });
      }

      if (update.callback_query) {
        const cb = update.callback_query;
        await answerCallback({ id: cb.id }).catch((err) =>
          console.error("telegram answerCallback failed", err),
        );
        const msg = cb.message;
        const userId = String(cb.from.id);
        if (!msg || !isPrivateChat(msg)) {
          return new Response(null, { status: 204 });
        }
        const tenant = await getTenantByTelegram(userId).catch(() => null);
        const callbackConversationId = chatConversationId(tenant);
        if (!tenant?.phoneE164 || !callbackConversationId) {
          await sendHtml(chatIdOf(msg), bindRefuseText("unknown_token")).catch(
            (err) => console.error("telegram unbound callback", err),
          );
          return new Response(null, { status: 204 });
        }
        const data = (cb.data ?? "").trim();
        if (!data) return new Response(null, { status: 204 });
        parkLastChannelTouch(waitUntil, touchLastChannel(tenant.phoneE164, "telegram"));
        const typing = sendTelegramTyping(chatIdOf(msg)).catch((err) =>
          console.error("telegram typing failed", err),
        );
        parkTurn(waitUntil, typing);
        parkTurn(
          waitUntil,
          from(callbackConversationId).send(`[button] ${data}`, {
            auth: {
              authenticator: "telegram",
              issuer: "telegram",
              principalType: "user",
              principalId: tenant.phoneE164,
              attributes: telegramAuthAttrs({
                conversationId: callbackConversationId,
                telegramChatId: tenant.telegramChatId ?? chatIdOf(msg),
                telegramUserId: userId,
                messageId: String(msg.message_id),
                inkboxHandle: tenant.inkboxHandle,
                text: `[button] ${data}`,
              }),
            },
          }),
        );
        return new Response(null, { status: 204 });
      }

      const msg = update.message;
      if (!msg || !isPrivateChat(msg)) {
        return new Response(null, { status: 204 });
      }
      const userId = userIdOf(msg);
      const chatId = chatIdOf(msg);
      if (!userId) return new Response(null, { status: 204 });

      const start = parseTelegramStart(msg.text ?? "");
      if (start) {
        if (!start.token) {
          const existing = await getTenantByTelegram(userId).catch(() => null);
          if (existing?.phoneE164) {
            await sendHtml(chatId, telegramWelcomeText()).catch((err) =>
              console.error("telegram welcome failed", err),
            );
            return new Response(null, { status: 204 });
          }
          await sendHtml(chatId, bindRefuseText("unknown_token")).catch((err) =>
            console.error("telegram unbound start", err),
          );
          return new Response(null, { status: 204 });
        }
        const bound = await bindTelegram({
          token: start.token,
          telegramUserId: userId,
          telegramChatId: chatId,
          telegramUsername: msg.from?.username,
        }).catch((err) => {
          console.error("bind telegram failed", err);
          return { ok: false as const, reason: "unknown_token" as const };
        });
        if (!bound.ok) {
          await sendHtml(chatId, bindRefuseText(bound.reason)).catch((err) =>
            console.error("telegram bind refuse failed", err),
          );
          return new Response(null, { status: 204 });
        }
        await sendHtml(chatId, telegramWelcomeText()).catch((err) =>
          console.error("telegram welcome failed", err),
        );
        return new Response(null, { status: 204 });
      }

      const tenant = await getTenantByTelegram(userId).catch(() => null);
      const conversationId = chatConversationId(tenant);
      if (!tenant?.phoneE164 || !conversationId) {
        await sendHtml(chatId, bindRefuseText("unknown_token")).catch((err) =>
          console.error("telegram unbound inbound", err),
        );
        return new Response(null, { status: 204 });
      }
      const phone = tenant.phoneE164;

      const inboundP = inboundTelegramText(msg);
      const photoP = inboundTelegramPhotoParts(msg);
      parkTurn(
        waitUntil,
        saveTelegramInboundFiles(phone, msg).catch((err) =>
          console.error("telegram inbound file save failed", err),
        ),
      );
      const inbound = await inboundP;
      // Fast-ack lane: started only once the voice transcript (if any)
      // resolved — text-only messages get no extra wait since inboundP was
      // already in flight above.
      const fastAck = startFastAck(inbound.text);
      const cancelFastAck = () => fastAck?.abort();
      if (inbound.allVoiceFailed) {
        cancelFastAck();
        await sendHtml(chatId, VOICE_FAILED_REPLY).catch((err) =>
          console.error("telegram voice fail reply", err),
        );
        return new Response(null, { status: 204 });
      }
      if (!inbound.text && !largestPhoto(msg)) {
        cancelFastAck();
        return new Response(null, { status: 204 });
      }

      const typing = sendTelegramTyping(chatId).catch((err) =>
        console.error("telegram typing failed", err),
      );
      parkTurn(waitUntil, typing);
      void loadWakeContext(phone).catch((err) =>
        console.error("wake prefetch failed", err),
      );
      prefetchInstinctRecall(phone, inbound.text);
      prefetchOpenRouter();

      const gate = await inboundOwnerGate(phone);
      if (gate.decision === "drop") {
        cancelFastAck();
        return new Response(null, { status: 204 });
      }
      if (gate.decision === "paywall") {
        cancelFastAck();
        const line = gate.payUrl
          ? `Лимит на сегодня исчерпан 🙈 Полный доступ — 2000 ₽/мес:\n${gate.payUrl}`
          : "Лимит на сегодня исчерпан 🙈 Полный доступ — 2000 ₽/мес: напиши @оператору";
        await sendHtml(chatId, line).catch((err) =>
          console.error("telegram paywall send failed", err),
        );
        return new Response(null, { status: 204 });
      }

      if (isHelpAsk(inbound.text)) {
        let handle = storedHandle(tenant.inkboxHandle) ?? undefined;
        if (!handle) {
          const identityId =
            tenant.inkboxIdentityId?.trim() || tenant.telegramUserId?.trim() || "telegram";
          handle = await attachCabinetLogin({
            phoneE164: phone,
            identityId,
          })
            .then((row) => storedHandle(row.handle) ?? undefined)
            .catch((err) => {
              console.error("cabinet handle attach failed", err);
              return undefined;
            });
        }
        await sendHtml(
          chatId,
          helpText({ handle, cabinetBase: cabinetBaseUrl() }),
        ).catch((err) => console.error("telegram help failed", err));
      }
      if (isTelegramAsk(inbound.text)) {
        const bot = telegramBotUsername();
        const minted = await mintTelegramBind(phone).catch(() => null);
        if (bot && minted?.ok) {
          await sendHtml(
            chatId,
            `Уже этот чат. Если ссылка нужна ещё раз:\n${telegramBindLink(bot, minted.token)}`,
          ).catch((err) => console.error("telegram relink failed", err));
        } else {
          await sendHtml(chatId, telegramWelcomeText()).catch((err) =>
            console.error("telegram already linked", err),
          );
        }
      }
      if (shouldSkipAgentTurn({ firstBind: false, text: inbound.text || "фото" })) {
        cancelFastAck();
        return new Response(null, { status: 204 });
      }

      parkLastChannelTouch(waitUntil, touchLastChannel(phone, "telegram"));

      const content = assembleInboundContent(inbound.text, await photoP);
      console.log("telegram inbound", {
        phone,
        conversationId,
        chars: inbound.text.length,
        voice: inbound.voice,
        images: typeof content === "string" ? 0 : content.length - 1,
        queuedAfterMs: Date.now() - receivedAt,
      });
      const ackText = await settleFastAck(fastAck, { budgetMs: fastAckBudgetMs() });
      if (ackText) {
        parkTurn(
          waitUntil,
          deliverHumanRouted({
            attrs: {
              conversationId,
              telegramChatId: chatId,
              inkboxHandle: tenant.inkboxHandle,
              origin: "human",
              channel: "telegram",
            },
            tenant,
            conversationId,
            text: ackText,
            principalId: phone,
          }).catch((err) => console.error("fast ack deliver failed", err)),
        );
        console.log("fast ack sent", {
          conversationId,
          chars: ackText.length,
          sinceInboundMs: Date.now() - receivedAt,
        });
      }
      parkTurn(
        waitUntil,
        from(conversationId).send(content, {
          auth: {
            authenticator: "telegram",
            issuer: "telegram",
            principalType: "user",
            principalId: phone,
            attributes: telegramAuthAttrs({
              conversationId,
              telegramChatId: chatId,
              telegramUserId: userId,
              messageId: String(msg.message_id),
              inkboxHandle: tenant.inkboxHandle,
              text: inbound.text,
              receivedAt,
              fastAck: ackText,
            }),
          },
        }),
      );
      return new Response(null, { status: 204 });
    }),
  ],
});
