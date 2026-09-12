import { noteTurnFailed, replyTenant, setWakeupLastSeen } from "./convex.ts";
import { deliverHuman } from "./deliver-human.ts";
import {
  bubblesFor,
  planPreToolFlush,
  planStreamFlush,
  planTurnDelivery,
  recordSent,
  rememberSoFar,
  soFarFor,
  type EarlySentRow,
} from "./early-deliver.ts";
import {
  fallbackForFailed,
  takeFallbackSlot,
  turnOrigin,
} from "./silent-turn.ts";
import { stripConnectUrls } from "./connect-link.ts";
import {
  routingFromAuth,
  routingPhone,
  routingTenant,
  type AuthAttrs,
} from "./turn-routing.ts";

export function telegramOwnsTurn(attrs: AuthAttrs): boolean {
  return routingFromAuth(attrs).channel === "telegram";
}

export function imessageOwnsTurn(attrs: AuthAttrs): boolean {
  return !telegramOwnsTurn(attrs);
}

type DeliveryAuth = {
  attributes?: AuthAttrs;
  principalId?: string | null;
};

type DeliveryChannel = {
  continuation?: { token?: string };
};

type DeliveryCtx = {
  session?: {
    auth?: {
      current?: DeliveryAuth | null;
      initiator?: DeliveryAuth | null;
    };
  };
};

function recordAttrs(attrs: AuthAttrs): Record<string, unknown> {
  if (!attrs || typeof attrs !== "object") return {};
  return { ...attrs };
}

function authOf(ctx: DeliveryCtx | undefined): DeliveryAuth | undefined {
  const current = ctx?.session?.auth?.current ?? undefined;
  const initiator = ctx?.session?.auth?.initiator ?? undefined;
  if (!current && !initiator) return undefined;
  return {
    principalId: current?.principalId ?? initiator?.principalId,
    attributes: {
      ...recordAttrs(initiator?.attributes),
      ...recordAttrs(current?.attributes),
    },
  };
}

function conversationIdOf(
  channel: DeliveryChannel,
  attrs: AuthAttrs,
): string {
  const token = channel.continuation?.token?.trim();
  if (token) return token;
  const raw = attrs?.conversationId;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].trim()) {
    return raw[0].trim();
  }
  return "";
}

function canTarget(conversationId: string, attrs: AuthAttrs): boolean {
  return Boolean(conversationId) || routingFromAuth(attrs).canDeliver;
}

async function persistSeen(
  phone: string | undefined,
  seen: string | undefined,
): Promise<void> {
  if (!phone || seen === undefined) return;
  await setWakeupLastSeen(phone, seen).catch((err) => {
    console.error("setLastSeen failed", err);
  });
}

async function persistSeenFromTurn(
  conversationId: string,
  attrs: AuthAttrs,
  principalId: string | null | undefined,
  seen: string | undefined,
): Promise<void> {
  if (seen === undefined) return;
  const phone = routingPhone(routingFromAuth(attrs), principalId);
  if (phone) {
    await persistSeen(phone, seen);
    return;
  }
  if (!conversationId) return;
  const tenant = await replyTenant(conversationId).catch((err) => {
    console.error("setLastSeen failed", err);
    return null;
  });
  if (tenant?.phoneE164) await persistSeen(tenant.phoneE164, seen);
}

export async function deliverTurnBubble(opts: {
  conversationId: string;
  text: string;
  attrs?: AuthAttrs;
  principalId?: string | null;
  seen?: string;
}): Promise<void> {
  const routing = routingFromAuth(opts.attrs);
  const lookedUp =
    routing.canDeliver || !opts.conversationId
      ? null
      : await replyTenant(opts.conversationId);
  const tenant = lookedUp ?? routingTenant(routing);
  const phone = routingPhone(routing, opts.principalId) ?? lookedUp?.phoneE164;
  await deliverHuman({
    tenant: { ...tenant, ...(phone ? { phoneE164: phone } : {}) },
    conversationId: opts.conversationId || undefined,
    text: opts.text,
    channel: routing.channel,
  });
  await persistSeen(phone, opts.seen);
}

export function createTurnDeliveryEvents(opts: {
  accept: (attrs: AuthAttrs) => boolean;
}) {
  const fallbackSent = new Map<string, number>();
  const earlySent = new Map<string, EarlySentRow>();

  return {
    async "turn.failed"(
      event: { turnId: string; code?: string; message?: string },
      channel: DeliveryChannel,
      ctx?: DeliveryCtx,
    ) {
      const auth = authOf(ctx);
      const conversationId = conversationIdOf(channel, auth?.attributes);
      console.error("turn failed", {
        conversationId,
        code: event.code,
        message: event.message,
        accept: opts.accept(auth?.attributes),
        routed: routingFromAuth(auth?.attributes).channel ?? null,
      });
      const failedPhone = routingPhone(
        routingFromAuth(auth?.attributes),
        auth?.principalId,
      );
      if (failedPhone) {
        void noteTurnFailed(failedPhone, event.code, event.message).catch(
          (err) => console.error("ops turn_failed", err),
        );
      }
      if (!canTarget(conversationId, auth?.attributes)) return;
      if (!opts.accept(auth?.attributes)) return;
      const text = fallbackForFailed(turnOrigin(auth?.attributes));
      if (!text) return;
      if (!takeFallbackSlot(fallbackSent, event.turnId, Date.now())) return;
      await deliverTurnBubble({
        conversationId,
        text,
        attrs: auth?.attributes,
        principalId: auth?.principalId,
      }).catch((err) =>
        console.error("turn failed fallback send failed", err),
      );
    },
    async "message.appended"(
      event: { turnId: string; messageSoFar: string },
      channel: DeliveryChannel,
      ctx?: DeliveryCtx,
    ) {
      const auth = authOf(ctx);
      const conversationId = conversationIdOf(channel, auth?.attributes);
      if (!canTarget(conversationId, auth?.attributes)) return;
      if (!opts.accept(auth?.attributes)) return;
      rememberSoFar(earlySent, event.turnId, event.messageSoFar, Date.now());
      const planned = planStreamFlush({
        soFar: event.messageSoFar,
        alreadySent: bubblesFor(earlySent, event.turnId),
      });
      if (!planned.send) return;
      recordSent(earlySent, event.turnId, planned.send, Date.now());
      console.log("turn deliver appended", {
        conversationId,
        routed: routingFromAuth(auth?.attributes).channel ?? null,
        chars: planned.send.length,
      });
      void deliverTurnBubble({
        conversationId,
        text: stripConnectUrls(planned.send),
        attrs: auth?.attributes,
        principalId: auth?.principalId,
        seen: planned.seen,
      }).catch((err) => console.error("streamed bubble send failed", err));
    },
    async "actions.requested"(
      event: { turnId: string },
      channel: DeliveryChannel,
      ctx?: DeliveryCtx,
    ) {
      const auth = authOf(ctx);
      const conversationId = conversationIdOf(channel, auth?.attributes);
      if (!canTarget(conversationId, auth?.attributes)) return;
      if (!opts.accept(auth?.attributes)) return;
      const planned = planPreToolFlush({
        soFar: soFarFor(earlySent, event.turnId),
        alreadySent: bubblesFor(earlySent, event.turnId),
      });
      if (!planned.send) return;
      recordSent(earlySent, event.turnId, planned.send, Date.now());
      console.log("turn deliver pre-tool", {
        conversationId,
        routed: routingFromAuth(auth?.attributes).channel ?? null,
        chars: planned.send.length,
      });
      void deliverTurnBubble({
        conversationId,
        text: stripConnectUrls(planned.send),
        attrs: auth?.attributes,
        principalId: auth?.principalId,
        seen: planned.seen,
      }).catch((err) => console.error("pre-tool bubble send failed", err));
    },
    async "message.completed"(
      event: {
        turnId: string;
        finishReason?: string;
        message?: string | null;
      },
      channel: DeliveryChannel,
      ctx?: DeliveryCtx,
    ) {
      const auth = authOf(ctx);
      const conversationId = conversationIdOf(channel, auth?.attributes);
      if (!canTarget(conversationId, auth?.attributes)) {
        console.error("deliver skip: no target", {
          turnId: event.turnId,
          routed: routingFromAuth(auth?.attributes).channel ?? null,
        });
        return;
      }
      if (!opts.accept(auth?.attributes)) {
        console.log("deliver skip: other channel", {
          turnId: event.turnId,
          routed: routingFromAuth(auth?.attributes).channel ?? null,
        });
        return;
      }
      const origin = turnOrigin(auth?.attributes);
      const planned = planTurnDelivery({
        finishReason: event.finishReason ?? "",
        message: event.message,
        origin,
        alreadySent: bubblesFor(earlySent, event.turnId),
      });
      if (planned.send) {
        recordSent(earlySent, event.turnId, planned.send, Date.now());
        console.log("turn deliver completed", {
          conversationId,
          routed: routingFromAuth(auth?.attributes).channel ?? null,
          chars: planned.send.length,
        });
        await deliverTurnBubble({
          conversationId,
          text: stripConnectUrls(planned.send),
          attrs: auth?.attributes,
          principalId: auth?.principalId,
          seen: planned.seen,
        });
        return;
      }
      await persistSeenFromTurn(
        conversationId,
        auth?.attributes,
        auth?.principalId,
        planned.seen,
      );
      if (!planned.fallback) return;
      if (event.finishReason !== "tool-calls") {
        console.error("empty turn", {
          conversationId,
          finishReason: event.finishReason,
        });
      }
      if (!takeFallbackSlot(fallbackSent, event.turnId, Date.now())) return;
      await deliverTurnBubble({
        conversationId,
        text: planned.fallback,
        attrs: auth?.attributes,
        principalId: auth?.principalId,
      }).catch((err) => console.error("empty turn fallback send failed", err));
    },
  };
}

/** Used only by `agent/hooks/telegram-deliver.ts`. Do not also attach these
 *  to the Telegram channel — Eve bundles hook and channel separately, so
 *  the Maps would not be shared and every bubble would send twice. */
export const telegramDeliveryEvents = createTurnDeliveryEvents({
  accept: telegramOwnsTurn,
});

export const imessageDeliveryEvents = createTurnDeliveryEvents({
  accept: imessageOwnsTurn,
});
