import { sendBlueIMessage } from "./inkbox.ts";
import { toIMessageBubbles } from "./imessage-text.ts";
import { stripConnectUrls } from "./connect-link.ts";
import {
  canDeliverTelegram,
  lastChannelOf,
  type HumanChannel,
} from "../../convex/lib/telegramPolicy.ts";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  stopTelegramTyping,
} from "./telegram.ts";
import { compileTelegram, type TelegramButton } from "./telegram-text.ts";

export type HumanTenant = {
  phoneE164?: string;
  inkboxHandle?: string;
  inkboxConversationId?: string;
  telegramChatId?: string;
  lastChannel?: string;
};

export async function deliverHuman(opts: {
  tenant: HumanTenant | null | undefined;
  conversationId?: string;
  text: string;
  channel?: HumanChannel;
  buttons?: TelegramButton[][];
}): Promise<void> {
  const text = opts.text.trim();
  if (!text) return;
  const tenant = opts.tenant ?? {};
  const prefer = opts.channel ?? lastChannelOf(tenant.lastChannel);
  if (prefer === "telegram" && canDeliverTelegram(tenant.telegramChatId)) {
    try {
      await deliverTelegram(tenant.telegramChatId!, text, opts.buttons);
      stopTelegramTyping(tenant.telegramChatId!);
      return;
    } catch (err) {
      console.error("telegram deliver failed, falling back to iMessage", err);
    }
  }
  if (tenant.telegramChatId) stopTelegramTyping(tenant.telegramChatId);
  const conversationId = opts.conversationId ?? tenant.inkboxConversationId;
  if (!conversationId) throw new Error("no conversation to deliver");
  const bubbles = toIMessageBubbles(stripConnectUrls(text));
  for (const bubble of bubbles) {
    await sendBlueIMessage({
      conversationId,
      text: bubble,
      handle: tenant.inkboxHandle,
    });
  }
}

async function deliverTelegram(
  chatId: string,
  text: string,
  extraButtons?: TelegramButton[][],
): Promise<void> {
  const compiled = compileTelegram(stripConnectUrls(text));
  const buttons =
    extraButtons && extraButtons.length > 0 ? extraButtons : compiled.buttons;
  const html = compiled.chunks[0] ?? compiled.html;
  const rest = compiled.chunks.slice(1);

  if (compiled.photos[0]) {
    await sendTelegramPhoto({
      chatId,
      url: compiled.photos[0],
      html: html || undefined,
      buttons,
    });
    for (const extra of compiled.photos.slice(1)) {
      await sendTelegramPhoto({ chatId, url: extra });
    }
    for (const chunk of rest) {
      await sendTelegramMessage({ chatId, html: chunk });
    }
    return;
  }

  if (html || (buttons && buttons.length > 0)) {
    await sendTelegramMessage({
      chatId,
      html: html || " ",
      buttons,
    });
  }
  for (const chunk of rest) {
    await sendTelegramMessage({ chatId, html: chunk });
  }
}
