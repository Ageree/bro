import { replyTenant, setWakeupLastSeen } from "./convex.ts";
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
  session?: { auth?: { current?: DeliveryAuth | null } };
};

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
  const lookedUp = routing.canDeliver
    ? null
    : await replyTenant(opts.conversationId);
  const tenant = lookedUp ?? routingTenant(routing);
  await deliverHuman({
    tenant,
    conversationId: opts.conversationId,
    text: opts.text,
    channel: routing.channel,
  });
  await persistSeen(
    routingPhone(routing, opts.principalId) ?? lookedUp?.phoneE164,
    opts.seen,
  );
}

export function createTurnDeliveryEvents(opts: {
  accept: (attrs: AuthAttrs) => boolean;
}) {
  const fallbackSent = new Map<string, number>();
  const earlySent = new Map<string, EarlySentRow>();

  function authOf(ctx: DeliveryCtx | undefined): DeliveryAuth | undefined {
    return ctx?.session?.auth?.current ?? undefined;
  }

  function conversationIdOf(channel: DeliveryChannel): string | undefined {
    return channel.continuation?.token;
  }

  return {
    async "turn.failed"(
      event: { turnId: string; code?: string; message?: string },
      channel: DeliveryChannel,
      ctx?: DeliveryCtx,
    ) {
      const conversationId = conversationIdOf(channel);
      if (!conversationId) return;
      console.error("turn failed", {
        conversationId,
        code: event.code,
        message: event.message,
      });
      const auth = authOf(ctx);
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
      const conversationId = conversationIdOf(channel);
      if (!conversationId) return;
      const auth = authOf(ctx);
      if (!opts.accept(auth?.attributes)) return;
      rememberSoFar(earlySent, event.turnId, event.messageSoFar, Date.now());
      const planned = planStreamFlush({
        soFar: event.messageSoFar,
        alreadySent: bubblesFor(earlySent, event.turnId),
      });
      if (!planned.send) return;
      recordSent(earlySent, event.turnId, planned.send, Date.now());
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
      const conversationId = conversationIdOf(channel);
      if (!conversationId) return;
      const auth = authOf(ctx);
      if (!opts.accept(auth?.attributes)) return;
      const planned = planPreToolFlush({
        soFar: soFarFor(earlySent, event.turnId),
        alreadySent: bubblesFor(earlySent, event.turnId),
      });
      if (!planned.send) return;
      recordSent(earlySent, event.turnId, planned.send, Date.now());
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
      const conversationId = conversationIdOf(channel);
      if (!conversationId) return;
      const auth = authOf(ctx);
      if (!opts.accept(auth?.attributes)) return;
      const origin = turnOrigin(auth?.attributes);
      const planned = planTurnDelivery({
        finishReason: event.finishReason ?? "",
        message: event.message,
        origin,
        alreadySent: bubblesFor(earlySent, event.turnId),
      });
      if (planned.send) {
        recordSent(earlySent, event.turnId, planned.send, Date.now());
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
