import {
  createiMessageAdapter,
  type iMessageAdapter,
} from "@photon-ai/chat-adapter-imessage";
import type { AttachSessionFn } from "eve/channels";
import { z } from "zod";
import { browserNoticeAuthenticator } from "@agent/lib/browser-use/report-caller";
import { telegramChatIdFromConversationId } from "@agent/lib/telegram-conversation";
import { backgroundNoticeMessage } from "@shared/chat/background-turn";
import { env } from "@shared/environment";
import { photonProjectCredentials } from "@shared/photon/credentials";

const telegramApiBaseUrl = "https://api.telegram.org";
const sendTimeoutMs = 10_000;
const telegramReplySchema = z.object({ ok: z.boolean() });

let photonAdapter: iMessageAdapter | undefined;

/**
 * A notice code wrote, sent to the person's conversation without the model:
 * a browser report that never got through (`abandoned-notice.ts`), how a
 * wallet payment settled (`agent/lib/yoomoney/notice.ts`). Telegram and
 * iMessage take the text straight; throws when it did not land.
 */
export async function sendCodeNotice(
  delivery: { readonly attachSession?: AttachSessionFn },
  target: {
    readonly conversationChannel: "eve" | "photon" | "telegram";
    readonly conversationId: string;
    readonly workspaceId: string;
    readonly userId: string;
    /** What the notice is about, on the web chat's caller (`browserRunId`…). */
    readonly about: Readonly<Record<string, string>>;
  },
  text: string
) {
  if (target.conversationChannel === "telegram") {
    const chatId = telegramChatIdFromConversationId(target.conversationId);
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (!chatId || !botToken) {
      throw new Error("Telegram is not set up for this conversation.");
    }
    const response = await fetch(
      `${telegramApiBaseUrl}/bot${botToken}/sendMessage`,
      {
        body: JSON.stringify({ chat_id: chatId, text }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(sendTimeoutMs),
      }
    );
    const accepted = telegramReplySchema.safeParse(
      await response.json().catch(() => undefined)
    ).data?.ok;
    if (!response.ok || accepted !== true) {
      throw new Error(`Telegram notice failed (${String(response.status)}).`);
    }
    return;
  }
  if (target.conversationChannel === "photon") {
    photonAdapter ??= createiMessageAdapter({
      credentials: photonProjectCredentials,
    });
    await photonAdapter.postMessage(target.conversationId, { raw: text });
    return;
  }
  // A web chat has no address, only a handle on its session, and whatever
  // reaches the session starts a turn. This one calls no model (the agent's
  // `step.started`), and the chat shows the notice as Bro's message.
  if (!delivery.attachSession) {
    throw new Error("A web chat notice needs a session handle.");
  }
  const result = await delivery
    .attachSession(target.conversationId)
    .send(backgroundNoticeMessage(text), {
      auth: {
        attributes: {
          ...target.about,
          conversationChannel: target.conversationChannel,
          conversationId: target.conversationId,
          workspaceId: target.workspaceId,
        },
        authenticator: browserNoticeAuthenticator,
        issuer: "open-instinct",
        principalId: target.userId,
        principalType: "user",
      },
      turnPolicy: "queue",
    });
  if (result.status !== "accepted") {
    throw new Error(
      `The web chat did not take the notice (${result.status}, retryable: ${String(result.retryable === true)}).`
    );
  }
}
