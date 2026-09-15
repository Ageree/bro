import { replyTenant, setWakeupLastSeen } from "./convex.ts";
import { deliverHuman } from "./deliver-human.ts";
import {
  bubblesFor,
  isIncompleteDraft,
  isThinFragment,
  planPreToolFlush,
  planStreamFlush,
  planTurnDelivery,
  recordSent,
  rememberSoFar,
  soFarFor,
  type EarlySentRow,
} from "./early-deliver.ts";
import {
  browserPollForceSpeak,
  fallbackForFailed,
  takeFallbackSlot,
  turnOrigin,
  wakeupFallbackText,
} from "./silent-turn.ts";
import { stripConnectUrls } from "./connect-link.ts";
import { latencyFields } from "./latency-log.ts";
import { fastAckOf, peelFastAck } from "./fast-ack.ts";
import { sendPhotonTyping } from "./photon.ts";
import { sendTelegramTyping } from "./telegram.ts";
import {
  routingFromAuth,
  routingPhone,
  routingTenant,
  type AuthAttrs,
} from "./turn-routing.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A `message.completed` delivery failure (network blip, Convex hiccup) must
// never leave a resolved browser_poll wakeup silent — retry once, since
// claimChatBubble's per-chat dedupe (agent/lib/bubble-dedupe.ts) already
// keeps a retry from resending a bubble that actually made it out.
const COMPLETED_DELIVERY_RETRY_MS = 1_500;

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
  // Bookkeeping, not a reply: never hold the bubble (or the turn) on it.
  void persistSeen(phone, opts.seen);
}

/** Re-arm «печатает…» while Bro works (a sent bubble clears it on the phone),
 *  or drop it when a turn ends without a bubble. Best effort, never awaited. */
export function signalTurnTyping(opts: {
  conversationId: string;
  attrs?: AuthAttrs;
  state: "start" | "stop";
}): void {
  const routing = routingFromAuth(opts.attrs);
  if (routing.channel === "telegram") {
    if (opts.state !== "start" || !routing.telegramChatId) return;
    void sendTelegramTyping(routing.telegramChatId).catch((err) =>
      console.error("telegram typing failed", err),
    );
    return;
  }
  if (!opts.conversationId) return;
  void sendPhotonTyping({ conversationId: opts.conversationId, state: opts.state });
}

export function createTurnDeliveryEvents(opts: {
  accept: (attrs: AuthAttrs) => boolean;
}) {
  const fallbackSent = new Map<string, number>();
  const earlySent = new Map<string, EarlySentRow>();

  // A fast-ack line was already sent before the turn started (stamped on the
  // auth attributes — it lives in a different process than this Map). Fold
  // it into `alreadySent` so nextBubble's restatement/near-duplicate peeling
  // drops a repeated looking line, without counting as a real spoken bubble
  // for the empty-turn fallback (see `realSent` on planTurnDelivery).
  function alreadySentFor(attrs: AuthAttrs, turnId: string): readonly string[] {
    const ack = fastAckOf(attrs);
    const bubbles = bubblesFor(earlySent, turnId);
    return ack ? [ack, ...bubbles] : bubbles;
  }

  /** Until a real bubble went out, the model's first text may restate the
   *  fast ack in another case («Ищу на ВБ.») — drop or peel that. */
  function afterFastAck(
    attrs: AuthAttrs,
    turnId: string,
    send: string | null,
  ): string | null {
    if (!send) return null;
    const ack = fastAckOf(attrs);
    if (!ack || bubblesFor(earlySent, turnId).length > 0) return send;
    const peeled = peelFastAck(ack, send);
    if (!peeled || peeled === send) return peeled;
    return isIncompleteDraft(peeled) || isThinFragment(peeled) ? null : peeled;
  }

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
      if (!canTarget(conversationId, auth?.attributes)) return;
      if (!opts.accept(auth?.attributes)) return;
      const text = fallbackForFailed(auth?.attributes);
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
      const streamPlan = planStreamFlush({
        soFar: event.messageSoFar,
        alreadySent: alreadySentFor(auth?.attributes, event.turnId),
      });
      const planned = {
        ...streamPlan,
        send: afterFastAck(auth?.attributes, event.turnId, streamPlan.send),
      };
      if (!planned.send) return;
      recordSent(earlySent, event.turnId, planned.send, Date.now());
      console.log("turn deliver appended", {
        conversationId,
        ...latencyFields(auth?.attributes),
        routed: routingFromAuth(auth?.attributes).channel ?? null,
        chars: planned.send.length,
      });
      const bubbleNo = bubblesFor(earlySent, event.turnId).length;
      void deliverTurnBubble({
        conversationId,
        text: stripConnectUrls(planned.send),
        attrs: auth?.attributes,
        principalId: auth?.principalId,
        seen: planned.seen,
      })
        .then(() => {
          if (bubbleNo === 1) {
            console.log("turn first bubble delivered", {
              conversationId,
              ...latencyFields(auth?.attributes),
            });
          }
        })
        .catch((err) => console.error("streamed bubble send failed", err));
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
      const preToolPlan = planPreToolFlush({
        soFar: soFarFor(earlySent, event.turnId),
        alreadySent: alreadySentFor(auth?.attributes, event.turnId),
      });
      const planned = {
        ...preToolPlan,
        send: afterFastAck(auth?.attributes, event.turnId, preToolPlan.send),
      };
      if (!planned.send) {
        signalTurnTyping({ conversationId, attrs: auth?.attributes, state: "start" });
        return;
      }
      recordSent(earlySent, event.turnId, planned.send, Date.now());
      console.log("turn deliver pre-tool", {
        conversationId,
        ...latencyFields(auth?.attributes),
        routed: routingFromAuth(auth?.attributes).channel ?? null,
        chars: planned.send.length,
      });
      void deliverTurnBubble({
        conversationId,
        text: stripConnectUrls(planned.send),
        attrs: auth?.attributes,
        principalId: auth?.principalId,
        seen: planned.seen,
      })
        .catch((err) => console.error("pre-tool bubble send failed", err))
        .finally(() => {
          // The bubble cleared the indicator; tools are still running.
          signalTurnTyping({ conversationId, attrs: auth?.attributes, state: "start" });
        });
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
      const turnPlan = planTurnDelivery({
        finishReason: event.finishReason ?? "",
        message: event.message,
        origin,
        alreadySent: alreadySentFor(auth?.attributes, event.turnId),
        realSent: bubblesFor(earlySent, event.turnId),
      });
      const planned = {
        ...turnPlan,
        send: afterFastAck(auth?.attributes, event.turnId, turnPlan.send),
      };
      if (planned.send) {
        recordSent(earlySent, event.turnId, planned.send, Date.now());
        console.log("turn deliver completed", {
          conversationId,
          ...latencyFields(auth?.attributes),
          routed: routingFromAuth(auth?.attributes).channel ?? null,
          chars: planned.send.length,
        });
        const bubbleOpts = {
          conversationId,
          text: stripConnectUrls(planned.send),
          attrs: auth?.attributes,
          principalId: auth?.principalId,
          seen: planned.seen,
        };
        await deliverTurnBubble(bubbleOpts).catch(async (err) => {
          console.error("message delivery failed", {
            conversationId,
            turnId: event.turnId,
            err,
          });
          // Only worth a retry when silence would otherwise mean a resolved
          // errand the human never hears about (goal.md §2) — a plain human
          // turn's own turn.failed handler doesn't fire here (this branch
          // already produced real text), so there's no other rescue for it.
          if (!browserPollForceSpeak(auth?.attributes)) return;
          await delay(COMPLETED_DELIVERY_RETRY_MS);
          await deliverTurnBubble(bubbleOpts).catch((retryErr) =>
            console.error("message delivery retry failed", {
              conversationId,
              turnId: event.turnId,
              err: retryErr,
            }),
          );
        });
        return;
      }
      await persistSeenFromTurn(
        conversationId,
        auth?.attributes,
        auth?.principalId,
        planned.seen,
      );
      // A wakeup turn's fallback only ever applies to a real end-of-turn
      // silence, never to a mid-turn tool call — planTurnDelivery already
      // enforces the equivalent rule for the human TURN_FAILED_REPLY. It also
      // must not fire once the turn already spoke a real bubble (e.g. «код
      // из почты, ввожу» streamed before a tool call) — the model reported
      // in, it just has nothing further to add; sending the canned line too
      // would be a second, redundant bubble, not a rescue from silence.
      const spoke = bubblesFor(earlySent, event.turnId).some((s) => s.trim().length > 0);
      const wakeupFallback =
        event.finishReason !== "tool-calls" && !spoke
          ? wakeupFallbackText(auth?.attributes)
          : null;
      const fallbackText = planned.fallback ?? wakeupFallback;
      if (event.finishReason !== "tool-calls" && !fallbackText) {
        signalTurnTyping({ conversationId, attrs: auth?.attributes, state: "stop" });
      }
      if (!fallbackText) return;
      if (event.finishReason !== "tool-calls") {
        console.error("empty turn", {
          conversationId,
          finishReason: event.finishReason,
          wakeupFallback: Boolean(wakeupFallback),
        });
      }
      if (!takeFallbackSlot(fallbackSent, event.turnId, Date.now())) return;
      await deliverTurnBubble({
        conversationId,
        text: fallbackText,
        attrs: auth?.attributes,
        principalId: auth?.principalId,
      }).catch((err) => console.error("empty/wakeup turn fallback send failed", err));
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
