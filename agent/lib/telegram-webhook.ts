import type { ChannelFrom } from "eve/channels";
import type { UserContent } from "ai";
import {
  bindTelegram,
  countInboundMessage,
  getTenantByTelegram,
  markPaywallSent,
  mintTelegramBind,
  touchLastChannel,
} from "./convex";
import {
  helpText,
  isHelpAsk,
  isTelegramAsk,
  shouldSkipAgentTurn,
} from "./onboard-policy";
import { inboundUserContent } from "./inbound-image.ts";
import { transcribeVoiceNote } from "./voice";
import { inboundVoiceLine } from "./imessage-text";
import { VOICE_FAILED_REPLY } from "./voice-policy";
import { inboundGateFromResult } from "../../convex/lib/billingPolicy";
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
  startTelegramTyping,
  telegramBotUsername,
  telegramFileUrl,
  webhookSecretOk,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram";
import { compileTelegram } from "./telegram-text.ts";
import { TURN_FAILED_REPLY } from "./silent-turn.ts";

function telegramAuthAttrs(opts: {
  conversationId: string;
  telegramChatId: string;
  telegramUserId: string;
  messageId: string;
  inkboxHandle?: string;
}): Record<string, string> {
  return {
    conversationId: opts.conversationId,
    telegramChatId: opts.telegramChatId,
    telegramUserId: opts.telegramUserId,
    messageId: opts.messageId,
    origin: "human",
    channel: "telegram",
    ...(opts.inkboxHandle ? { inkboxHandle: opts.inkboxHandle } : {}),
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

async function inboundTelegramContent(
  text: string,
  msg: TelegramMessage,
): Promise<string | Awaited<ReturnType<typeof inboundUserContent>>> {
  const photo = largestPhoto(msg);
  if (!photo) return inboundUserContent(text, null);
  try {
    const url = await telegramFileUrl(photo.file_id);
    return await inboundUserContent(text, [
      {
        url,
        content_type: "image/jpeg",
        size: photo.file_size ?? null,
      },
    ]);
  } catch (err) {
    console.error("telegram photo fetch failed", err);
    return inboundUserContent(text, null);
  }
}

function steerBroTurn(
  from: ChannelFrom,
  opts: {
    conversationId: string;
    content: string | UserContent;
    phone: string;
    attributes: Record<string, string>;
  },
) {
  return from(opts.conversationId).send(opts.content, {
    auth: {
      authenticator: "inkbox",
      issuer: "inkbox",
      principalType: "user",
      principalId: opts.phone,
      attributes: opts.attributes,
    },
  });
}

export async function handleTelegramWebhook(
  request: Request,
  args: {
    from: ChannelFrom;
    waitUntil: (task: Promise<unknown>) => void;
  },
): Promise<Response> {
  const { from, waitUntil } = args;
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
    if (!tenant?.phoneE164 || !tenant.inkboxConversationId) {
      await sendHtml(chatIdOf(msg), bindRefuseText("unknown_token")).catch(
        (err) => console.error("telegram unbound callback", err),
      );
      return new Response(null, { status: 204 });
    }
    const data = (cb.data ?? "").trim();
    if (!data) return new Response(null, { status: 204 });
    const conversationId = tenant.inkboxConversationId;
    waitUntil(
      touchLastChannel(tenant.phoneE164, "telegram").catch((err) =>
        console.error("touch last channel failed", err),
      ),
    );
    waitUntil(
      steerBroTurn(from, {
        conversationId,
        content: `[button] ${data}`,
        phone: tenant.phoneE164,
        attributes: telegramAuthAttrs({
          conversationId,
          telegramChatId: tenant.telegramChatId ?? chatIdOf(msg),
          telegramUserId: userId,
          messageId: String(msg.message_id),
          inkboxHandle: tenant.inkboxHandle,
        }),
      }).catch(async (err) => {
        console.error("telegram callback turn failed", err);
        await sendHtml(chatIdOf(msg), TURN_FAILED_REPLY).catch((sendErr) =>
          console.error("telegram callback fallback failed", sendErr),
        );
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
  if (!tenant?.phoneE164 || !tenant.inkboxConversationId) {
    await sendHtml(chatId, bindRefuseText("unknown_token")).catch((err) =>
      console.error("telegram unbound inbound", err),
    );
    return new Response(null, { status: 204 });
  }
  const phone = tenant.phoneE164;
  const conversationId = tenant.inkboxConversationId;

  const inbound = await inboundTelegramText(msg);
  if (inbound.allVoiceFailed) {
    await sendHtml(chatId, VOICE_FAILED_REPLY).catch((err) =>
      console.error("telegram voice fail reply", err),
    );
    return new Response(null, { status: 204 });
  }
  if (!inbound.text && !largestPhoto(msg)) {
    return new Response(null, { status: 204 });
  }

  let gate: { decision: "allow" | "paywall" | "drop"; payUrl?: string };
  try {
    gate = inboundGateFromResult(await countInboundMessage(phone), undefined);
  } catch (err) {
    console.error("billing count failed", err);
    try {
      const marked = await markPaywallSent(phone);
      gate = inboundGateFromResult(undefined, err, {
        alreadySentToday: marked.alreadySentToday,
        marked: true,
      });
    } catch (markErr) {
      console.error("paywallSentDayKey persist failed", markErr);
      gate = inboundGateFromResult(undefined, err, {
        alreadySentToday: false,
        marked: false,
      });
    }
  }
  if (gate.decision === "drop") return new Response(null, { status: 204 });
  if (gate.decision === "paywall") {
    const line = gate.payUrl
      ? `Лимит на сегодня исчерпан 🙈 Полный доступ — 2000 ₽/мес:\n${gate.payUrl}`
      : "Лимит на сегодня исчерпан 🙈 Полный доступ — 2000 ₽/мес: напиши @оператору";
    await sendHtml(chatId, line).catch((err) =>
      console.error("telegram paywall send failed", err),
    );
    return new Response(null, { status: 204 });
  }

  if (isHelpAsk(inbound.text)) {
    await sendHtml(chatId, helpText()).catch((err) =>
      console.error("telegram help failed", err),
    );
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
    return new Response(null, { status: 204 });
  }

  const content = await inboundTelegramContent(inbound.text, msg);
  console.log("telegram inbound", {
    phone,
    conversationId,
    chars: inbound.text.length,
    voice: inbound.voice,
    images: typeof content === "string" ? 0 : content.length - 1,
  });

  waitUntil(
    touchLastChannel(phone, "telegram").catch((err) =>
      console.error("touch last channel failed", err),
    ),
  );
  const stopTyping = startTelegramTyping(chatId);
  waitUntil(
    steerBroTurn(from, {
      conversationId,
      content,
      phone,
      attributes: telegramAuthAttrs({
        conversationId,
        telegramChatId: chatId,
        telegramUserId: userId,
        messageId: String(msg.message_id),
        inkboxHandle: tenant.inkboxHandle,
      }),
    })
      .catch(async (err) => {
        console.error("telegram turn send failed", err);
        await sendHtml(chatId, TURN_FAILED_REPLY).catch((sendErr) =>
          console.error("telegram turn fallback failed", sendErr),
        );
      })
      .finally(stopTyping),
  );
  return new Response(null, { status: 204 });
}
