import { sendPhotonText } from "./photon.ts";
import { outboundIMessageConversation } from "../../convex/lib/photonPolicy.ts";
import { toIMessageBubbles, toIMessageText } from "./imessage-text.ts";
import { stripConnectUrls } from "./connect-link.ts";
import {
  canDeliverTelegram,
  lastChannelOf,
  type HumanChannel,
} from "../../convex/lib/telegramPolicy.ts";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramRichMessage,
} from "./telegram.ts";
import { compileTelegram, type TelegramButton } from "./telegram-text.ts";
import {
  extractStoredFileRefs,
  extractMarkdownPhotoUrls,
  stripStoredFileRefs,
  stripMarkdownPhotos,
} from "./outbound-photo.ts";
import {
  photoFromStoredFile,
  sendPhotoToHuman,
  type SendPhotoDeps,
} from "./send-photo.ts";
import { claimChatBubble } from "./bubble-dedupe.ts";

export type HumanTenant = {
  phoneE164?: string;
  inkboxHandle?: string;
  inkboxConversationId?: string;
  photonConversationId?: string;
  telegramChatId?: string;
  lastChannel?: string;
};

export type DeliverHumanDeps = SendPhotoDeps & {
  sendIMessage?: (opts: {
    conversationId: string;
    text: string;
    handle?: string;
  }) => Promise<unknown>;
  sendTelegramMessage?: typeof sendTelegramMessage;
  sendTelegramPhotoUrl?: typeof sendTelegramPhoto;
  sendTelegramRichMessage?: typeof sendTelegramRichMessage;
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
  const conversationId = outboundIMessageConversation({
    requested: opts.conversationId,
    photonConversationId: tenant.photonConversationId,
    inkboxConversationId: tenant.inkboxConversationId,
  });
  const telegram =
    prefer === "telegram" && canDeliverTelegram(tenant.telegramChatId);

  const cleaned = stripConnectUrls(text);
  const storedNames = extractStoredFileRefs(cleaned);
  const remaining = stripStoredFileRefs(cleaned);
  if (storedNames.length > 0 && tenant.phoneE164) {
    const load =
      opts.deps?.loadStoredPhoto ??
      opts.deps?.loadComputerPhoto ??
      ((phone: string, name: string) => photoFromStoredFile(phone, { name }));
    for (const name of storedNames) {
      try {
        const photo = await load(tenant.phoneE164, name);
        const sent = await sendPhotoToHuman({
          channel: telegram ? "telegram" : "imessage",
          conversationId,
          telegramChatId: tenant.telegramChatId,
          handle: tenant.inkboxHandle,
          source: { kind: "bytes", photo },
          deps: opts.deps,
        });
        if (sent.status !== "ok") {
          console.error("stored photo send failed", name, sent.error);
        }
      } catch (err) {
        console.error("stored photo load failed", name, err);
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
  const sendText = opts.deps?.sendIMessage ?? sendPhotonText;
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
  const sendRich = deps?.sendTelegramRichMessage ?? sendTelegramRichMessage;

  if (compiled.preferRich && compiled.richHtml) {
    const claimed = claimChatBubble({ chatKey: chatId, text: compiled.richHtml });
    if (claimed) {
      try {
        await sendRich({
          chatId,
          html: compiled.richHtml,
          buttons,
        });
        return;
      } catch (err) {
        console.error("telegram rich fallback", err);
      }
    } else {
      return;
    }
  }

  if (compiled.photos[0]) {
    await sendPhoto({
      chatId,
      url: compiled.photos[0].url,
      html: html || undefined,
      buttons,
      hasSpoiler: compiled.photos[0].spoiler,
    });
    for (const extra of compiled.photos.slice(1)) {
      await sendPhoto({
        chatId,
        url: extra.url,
        hasSpoiler: extra.spoiler,
      });
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
