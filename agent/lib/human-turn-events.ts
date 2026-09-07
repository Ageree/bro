import type { ChannelEvents } from "eve/channels";
import { replyTenant, setWakeupLastSeen } from "./convex";
import { stripConnectUrls } from "./connect-link";
import { deliverHuman } from "./deliver-human";
import {
  fallbackForCompleted,
  fallbackForFailed,
  takeFallbackSlot,
  turnOrigin,
} from "./silent-turn.ts";
import { splitSeen } from "./wakeup-text";

// ponytail: in-memory only — lost on restart, not shared across instances
const fallbackSent = new Map<string, number>();

function conversationToken(channel: {
  continuation?: { token?: string };
}): string | undefined {
  const token = channel.continuation?.token;
  return token && token.length > 0 ? token : undefined;
}

function originOf(ctx: {
  session?: { auth?: { current?: { attributes?: Readonly<Record<string, string | readonly string[]>> } | null } };
}) {
  return turnOrigin(ctx.session?.auth?.current?.attributes);
}

/** Shared outbound for iMessage + Telegram. Eve fires these on the channel
 *  that started the turn — Telegram must declare them or the model replies
 *  into a void. */
export const humanTurnEvents: ChannelEvents = {
  async "turn.failed"(event, channel, ctx) {
    const conversationId = conversationToken(channel);
    if (!conversationId) return;
    console.error("turn failed", {
      conversationId,
      code: event.code,
      message: event.message,
    });
    const text = fallbackForFailed(originOf(ctx));
    if (!text) return;
    if (!takeFallbackSlot(fallbackSent, event.turnId, Date.now())) return;
    const tenant = await replyTenant(conversationId);
    await deliverHuman({ tenant, conversationId, text }).catch((err) =>
      console.error("turn failed fallback send failed", err),
    );
  },
  async "message.completed"(event, channel, ctx) {
    if (event.finishReason === "tool-calls") return;
    const conversationId = conversationToken(channel);
    if (!conversationId) return;
    if (!event.message) {
      const text = fallbackForCompleted({
        finishReason: event.finishReason ?? "stop",
        message: event.message,
        origin: originOf(ctx),
      });
      if (!text) return;
      console.error("empty turn", {
        conversationId,
        finishReason: event.finishReason,
      });
      if (!takeFallbackSlot(fallbackSent, event.turnId, Date.now())) return;
      const tenant = await replyTenant(conversationId);
      await deliverHuman({ tenant, conversationId, text }).catch((err) =>
        console.error("empty turn fallback send failed", err),
      );
      return;
    }
    const { message, seen } = splitSeen(event.message);
    const tenant = await replyTenant(conversationId);
    if (seen !== undefined && tenant?.phoneE164) {
      await setWakeupLastSeen(tenant.phoneE164, seen).catch((err) => {
        console.error("setLastSeen failed", err);
      });
    }
    if (!message.trim() || message.trim().startsWith("[SILENT]")) return;
    await deliverHuman({
      tenant,
      conversationId,
      text: stripConnectUrls(message),
    }).catch((err) => console.error("human turn deliver failed", err));
  },
};
