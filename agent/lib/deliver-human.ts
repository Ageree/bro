import { sendBlueIMessage } from "./inkbox.ts";
import { toIMessageBubbles, toIMessageText } from "./imessage-text.ts";
import { stripConnectUrls } from "./connect-link.ts";
import {
  canDeliverTelegram,
  lastChannelOf,
  type HumanChannel,
} from "../../convex/lib/telegramPolicy.ts";
import { sendTelegramMessage, sendTelegramPhoto } from "./telegram.ts";
import { compileTelegram, type TelegramButton } from "./telegram-text.ts";
import {
  extractComputerImagePaths,
  extractMarkdownPhotoUrls,
  stripComputerImagePaths,
  stripMarkdownPhotos,
} from "./outbound-photo.ts";
import {
  photoFromComputerPath,
  sendPhotoToHuman,
  type SendPhotoDeps,
} from "./send-photo.ts";
import { claimChatBubble } from "./bubble-dedupe.ts";

export type HumanTenant = {
  phoneE164?: string;
  inkboxHandle?: string;
  inkboxConversationId?: string;
  telegramChatId?: string;
  lastChannel?: string;
};

export type DeliverHumanDeps = SendPhotoDeps & {
  sendIMessage?: typeof sendBlueIMessage;
  sendTelegramMessage?: typeof sendTelegramMessage;
  sendTelegramPhotoUrl?: typeof sendTelegramPhoto;
};

export async function deliverHuman(opts: {
  tenant: HumanTenant | null | undefined;
  conversationId?: string;
  text: string;
  channel?: HumanChannel;
  buttons?: TelegramButton[][];
  deps?: DeliverHumanDeps;
}): Promise<void> {
  const text = opts.text.trim();
  if (!text) return;
  const tenant = opts.tenant ?? {};
  const prefer = opts.channel ?? lastChannelOf(tenant.lastChannel);
  const conversationId = opts.conversationId ?? tenant.inkboxConversationId;
  const telegram =
    prefer === "telegram" && canDeliverTelegram(tenant.telegramChatId);

  const cleaned = stripConnectUrls(text);
  const localPaths = extractComputerImagePaths(cleaned);
  const remaining = stripComputerImagePaths(cleaned);
  if (localPaths.length > 0 && tenant.phoneE164) {
    const load = opts.deps?.loadComputerPhoto ?? photoFromComputerPath;
    for (const path of localPaths) {
      try {
        const photo = await load(tenant.phoneE164, path);
        const sent = await sendPhotoToHuman({
          channel: telegram ? "telegram" : "imessage",
          conversationId,
          telegramChatId: tenant.telegramChatId,
          handle: tenant.inkboxHandle,
          source: { kind: "bytes", photo },
          deps: opts.deps,
        });
        if (sent.status !== "ok") {
          console.error("local photo send failed", path, sent.error);
        }
      } catch (err) {
        console.error("local photo load failed", path, err);
      }
    }
  }

  if (telegram) {
    try {
      await deliverTelegram(tenant.telegramChatId!, remaining, opts.buttons, opts.deps);
      return;
    } catch (err) {
      console.error("telegram deliver failed, falling back to iMessage", err);
    }
  }
  if (!conversationId) throw new Error("no conversation to deliver");
  await deliverIMessage({
    conversationId,
    handle: tenant.inkboxHandle,
    text: remaining,
    deps: opts.deps,
  });
}

async function deliverIMessage(opts: {
  conversationId: string;
  handle?: string;
  text: string;
  deps?: DeliverHumanDeps;
}): Promise<void> {
  const photos = extractMarkdownPhotoUrls(opts.text);
  const leftover = stripMarkdownPhotos(opts.text);
  const caption = leftover ? toIMessageText(leftover) : undefined;
  let attached = 0;
  for (const url of photos) {
    const sent = await sendPhotoToHuman({
      channel: "imessage",
      conversationId: opts.conversationId,
      handle: opts.handle,
      caption: attached === 0 ? caption : undefined,
      source: { kind: "url", url },
      deps: opts.deps,
    });
    if (sent.status === "ok") attached += 1;
    else console.error("imessage photo send failed", url, sent.error);
  }
  if (attached > 0) return;
  const sendText = opts.deps?.sendIMessage ?? sendBlueIMessage;
  const bubbles = toIMessageBubbles(opts.text);
  for (const bubble of bubbles) {
    if (
      !claimChatBubble({
        chatKey: opts.conversationId,
        text: bubble,
      })
    ) {
      continue;
    }
    await sendText({
      conversationId: opts.conversationId,
      text: bubble,
      handle: opts.handle,
    });
  }
}

async function deliverTelegram(
  chatId: string,
  text: string,
  extraButtons?: TelegramButton[][],
  deps?: DeliverHumanDeps,
): Promise<void> {
  const compiled = compileTelegram(text);
  const buttons =
    extraButtons && extraButtons.length > 0 ? extraButtons : compiled.buttons;
  const html = compiled.chunks[0] ?? compiled.html;
  const rest = compiled.chunks.slice(1);
  const sendPhoto = deps?.sendTelegramPhotoUrl ?? sendTelegramPhoto;
  const sendMessage = deps?.sendTelegramMessage ?? sendTelegramMessage;

  if (compiled.photos[0]) {
    await sendPhoto({
      chatId,
      url: compiled.photos[0],
      html: html || undefined,
      buttons,
    });
    for (const extra of compiled.photos.slice(1)) {
      await sendPhoto({ chatId, url: extra });
    }
    for (const chunk of rest) {
      if (!claimChatBubble({ chatKey: chatId, text: chunk })) continue;
      await sendMessage({ chatId, html: chunk });
    }
    return;
  }

  if (html || (buttons && buttons.length > 0)) {
    if (claimChatBubble({ chatKey: chatId, text: html || " " }) || (buttons && buttons.length > 0 && !html)) {
      await sendMessage({
        chatId,
        html: html || " ",
        buttons,
      });
    }
  }
  for (const chunk of rest) {
    if (!claimChatBubble({ chatKey: chatId, text: chunk })) continue;
    await sendMessage({ chatId, html: chunk });
  }
}
