import { defineChannel, GET, POST } from "eve/channels";
import type { IMessageWebhookPayload } from "@inkbox/sdk";
import {
  agentHandle,
  allowlisted,
  inkbox,
  isAccessHandle,
  isBlueIMessage,
  sendBlueIMessage,
  sendBlueIMessageMedia,
  webhookOk,
} from "../lib/inkbox";
import {
  bindGroupInbound,
  bindInbound,
  countInboundMessage,
  getGroupByConversation,
  getTenant,
  getTenantByHandle,
  markGroupGreeted,
  markPaywallSent,
  mintTelegramBind,
  replyTenant,
  setWakeupLastSeen,
  touchLastChannel,
  upsertTenant,
} from "../lib/convex";
import {
  broVcard,
  helpText,
  isHelpAsk,
  isTelegramAsk,
  shouldSkipAgentTurn,
  welcomeText,
} from "../lib/onboard-policy";
import { ingestInboundMail } from "../lib/mail-inbound";
import {
  connectCardHtml,
  isConnectDest,
  stripConnectUrls,
} from "../lib/connect-link";
import {
  inboundIMessageText,
  inboundIMessageTextWithVoice,
} from "../lib/imessage-text";
import { deliverHuman } from "../lib/deliver-human";
import { parkTurn } from "../lib/channel-turn.ts";
import {
  routingFromAuth,
  routingPhone,
  routingTenant,
} from "../lib/turn-routing.ts";
import { telegramBindLink } from "../../convex/lib/telegramPolicy.ts";
import { telegramBotUsername } from "../lib/telegram";
import { transcribeVoiceNote } from "../lib/voice";
import { inboundUserContent } from "../lib/inbound-image.ts";
import { VOICE_FAILED_REPLY } from "../lib/voice-policy";
import { watcherWakeupPrompt } from "../lib/purchase-policy";
import { wakeupCarriesRunId } from "../../convex/lib/browserFollowPolicy.ts";
import {
  releaseWakeupDelivery,
  takeWakeupDelivery,
} from "../lib/wakeup-dedupe";
import { inboundGateFromResult } from "../../convex/lib/billingPolicy";
import { eventPrompt } from "../../convex/lib/watcherPolicy.ts";
import { syncTenantArchive } from "../lib/archive-sync.ts";
import {
  fallbackForFailed,
  takeFallbackSlot,
  turnOrigin,
} from "../lib/silent-turn.ts";
import {
  bubblesFor,
  planTurnDelivery,
  recordSent,
} from "../lib/early-deliver.ts";
import {
  groupAuthAttributes,
  groupParticipantPhones,
  groupSenderPhone,
  groupWelcomeText,
  isGroupMessage,
  shouldReplyInGroup,
  tagGroupUserContent,
} from "../../convex/lib/groupChatPolicy.ts";

// ponytail: in-memory only — lost on restart, not shared across instances
const wakeupDelivered = new Map<string, number>();
const fallbackSent = new Map<string, number>();
const earlySent = new Map<string, { at: number; bubbles: string[] }>();

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
  attrs: Record<string, unknown> | undefined,
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

async function deliverTurnBubble(opts: {
  conversationId: string;
  text: string;
  attrs?: Record<string, unknown>;
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

async function sendFirstBindOnboard(opts: {
  conversationId: string;
  handle: string;
  email?: string;
  tel?: string;
}): Promise<void> {
  try {
    const identity = await inkbox().getIdentity(opts.handle);
    const upload = await identity.uploadIMessageMedia({
      content: new TextEncoder().encode(
        broVcard({ email: opts.email, tel: opts.tel }),
      ),
      filename: "Bro.vcf",
      contentType: "text/vcard",
    });
    await sendBlueIMessageMedia({
      conversationId: opts.conversationId,
      mediaUrls: [upload.mediaUrl],
      handle: opts.handle,
    });
  } catch (err) {
    console.error("onboard vcard failed", err);
  }
  try {
    await sendBlueIMessage({
      conversationId: opts.conversationId,
      text: welcomeText({ canJoinGroups: Boolean(opts.tel) }),
      handle: opts.handle,
    });
  } catch (err) {
    console.error("onboard welcome failed", err);
  }
}

async function sendGroupWelcome(opts: {
  conversationId: string;
  handle: string;
}): Promise<void> {
  try {
    await sendBlueIMessage({
      conversationId: opts.conversationId,
      text: groupWelcomeText(),
      handle: opts.handle,
    });
    await markGroupGreeted(opts.conversationId);
  } catch (err) {
    console.error("group welcome failed", err);
  }
}

async function sendHelpCatalog(opts: {
  conversationId: string;
  handle: string;
  canJoinGroups?: boolean;
}): Promise<void> {
  try {
    await sendBlueIMessage({
      conversationId: opts.conversationId,
      text: helpText({ canJoinGroups: opts.canJoinGroups }),
      handle: opts.handle,
    });
  } catch (err) {
    console.error("help catalog failed", err);
  }
}

async function sendTelegramInvite(opts: {
  conversationId: string;
  handle: string;
  phone: string;
}): Promise<void> {
  const bot = telegramBotUsername();
  if (!bot) {
    await sendBlueIMessage({
      conversationId: opts.conversationId,
      text: "Telegram у Bro ещё не включён.",
      handle: opts.handle,
    });
    return;
  }
  const minted = await mintTelegramBind(opts.phone);
  if (!minted.ok) {
    await sendBlueIMessage({
      conversationId: opts.conversationId,
      text: "Сначала напиши Bro в этот чат как обычно, потом «телеграм».",
      handle: opts.handle,
    });
    return;
  }
  const url = telegramBindLink(bot, minted.token);
  const text = minted.alreadyLinked
    ? `Чтобы переподключить Telegram, открой:\n${url}`
    : `Открой Telegram — тот же Bro, почта и поручения общие:\n${url}`;
  await sendBlueIMessage({
    conversationId: opts.conversationId,
    text,
    handle: opts.handle,
  });
}

async function inboundOwnerGate(ownerPhone: string): Promise<{
  decision: "allow" | "paywall" | "drop";
  payUrl?: string;
}> {
  try {
    return inboundGateFromResult(await countInboundMessage(ownerPhone), undefined);
  } catch (err) {
    console.error("billing count failed", err);
    try {
      const marked = await markPaywallSent(ownerPhone);
      return inboundGateFromResult(undefined, err, {
        alreadySentToday: marked.alreadySentToday,
        marked: true,
      });
    } catch (markErr) {
      console.error("paywallSentDayKey persist failed", markErr);
      return inboundGateFromResult(undefined, err, {
        alreadySentToday: false,
        marked: false,
      });
    }
  }
}

async function sendQuotaPaywall(opts: {
  conversationId: string;
  handle: string;
  payUrl?: string;
}): Promise<void> {
  const line = opts.payUrl
    ? `Лимит на сегодня исчерпан 🙈 Полный доступ — 2000 ₽/мес: ${opts.payUrl}`
    : "Лимит на сегодня исчерпан 🙈 Полный доступ — 2000 ₽/мес: напиши @оператору";
  try {
    await sendBlueIMessage({
      conversationId: opts.conversationId,
      text: line,
      handle: opts.handle,
    });
  } catch (err) {
    console.error("paywall send failed", err);
  }
}

function handleFromRequest(request: Request): string | undefined {
  try {
    const h = new URL(request.url).searchParams.get("h");
    if (h && isAccessHandle(h)) return h;
  } catch {
    return undefined;
  }
  return undefined;
}

export default defineChannel({
  turnPolicy: "steer",
  routes: [
    GET("/l", async (request) => {
      let dest = "";
      try {
        dest = new URL(request.url).searchParams.get("to") ?? "";
      } catch {
        dest = "";
      }
      if (!isConnectDest(dest)) {
        return new Response("bad link", { status: 400 });
      }
      return new Response(connectCardHtml(dest), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }),
    POST("/webhooks/imessage", async (request, { from, waitUntil }) => {
      const handle = handleFromRequest(request);
      const tenant = handle ? await getTenantByHandle(handle).catch(() => null) : null;
      const secret =
        tenant?.webhookSigningKey || process.env.INKBOX_WEBHOOK_SECRET;
      if (!secret) {
        return new Response("missing INKBOX_WEBHOOK_SECRET", { status: 500 });
      }

      const payload = Buffer.from(await request.arrayBuffer());
      if (!webhookOk(payload, request.headers, secret)) {
        return new Response("unauthorized", { status: 401 });
      }

      const body = JSON.parse(payload.toString()) as IMessageWebhookPayload;

      if (body.event_type === "imessage.delivery_failed") {
        console.error("imessage delivery failed", body.data.message);
        return new Response(null, { status: 204 });
      }
      if (body.event_type !== "imessage.received") {
        return new Response(null, { status: 204 });
      }

      const msg = body.data.message;
      if (!msg || msg.direction !== "inbound") {
        return new Response(null, { status: 204 });
      }
      if (
        !isBlueIMessage({
          service: msg.service,
          wasDowngraded: msg.was_downgraded,
        })
      ) {
        console.error("dropped non-imessage inbound", {
          service: msg.service,
          was_downgraded: msg.was_downgraded,
        });
        return new Response(null, { status: 204 });
      }

      const knownGroup = msg.conversation_id
        ? await getGroupByConversation(msg.conversation_id).catch(() => null)
        : null;
      const group = Boolean(knownGroup) || isGroupMessage(msg);
      const remote = group ? groupSenderPhone(msg) : msg.remote_number;
      if (!remote) {
        console.error("dropped inbound without remote number");
        return new Response(null, { status: 204 });
      }

      const identityHandle = handle ?? agentHandle();
      const participants = group ? groupParticipantPhones(msg) : [];

      let firstBind = false;
      let firstGroup = false;
      let boundTenant = tenant;
      let ownerPhone = remote;
      if (group) {
        if (!handle) {
          console.error("dropped group inbound without handle");
          return new Response(null, { status: 204 });
        }
        if (!allowlisted(remote)) {
          return new Response(null, { status: 204 });
        }
        const bound = await bindGroupInbound({
          conversationId: msg.conversation_id,
          senderPhone: remote,
          participants,
          handle,
        }).catch((err) => {
          console.error("bind group inbound failed", err);
          return { ok: false as const, reason: "error" };
        });
        if (!bound.ok) {
          console.error("dropped group inbound", bound.reason, handle, remote);
          return new Response(null, { status: 204 });
        }
        firstGroup = bound.firstGroup;
        ownerPhone = bound.ownerPhoneE164;
      } else if (handle) {
        const bound = await bindInbound(handle, remote, msg.conversation_id).catch(
          (err) => {
            console.error("bind inbound failed", err);
            return { ok: false as const, reason: "error" };
          },
        );
        if (!bound.ok) {
          console.error("dropped inbound", bound.reason, handle, remote);
          return new Response(null, { status: 204 });
        }
        firstBind = bound.firstBind;
        boundTenant = bound.tenant;
        ownerPhone = bound.tenant.phoneE164 ?? remote;
      } else {
        if (!allowlisted(remote)) {
          return new Response(null, { status: 204 });
        }
        try {
          await upsertTenant(remote, msg.conversation_id);
        } catch (err) {
          console.error("tenant upsert failed", err);
        }
      }

      const preview = inboundIMessageText(msg);
      if (!preview) {
        if (firstBind) {
          await sendFirstBindOnboard({
            conversationId: msg.conversation_id,
            handle: identityHandle,
            email: boundTenant?.emailAddress,
            tel: boundTenant?.dedicatedIMessageNumber,
          });
        }
        if (firstGroup) {
          await sendGroupWelcome({
            conversationId: msg.conversation_id,
            handle: identityHandle,
          });
        }
        return new Response(null, { status: 204 });
      }

      if (!group) {
        const gate = await inboundOwnerGate(ownerPhone);
        if (gate.decision === "drop") {
          return new Response(null, { status: 204 });
        }
        if (gate.decision === "paywall") {
          if (firstBind) {
            await sendFirstBindOnboard({
              conversationId: msg.conversation_id,
              handle: identityHandle,
              email: boundTenant?.emailAddress,
              tel: boundTenant?.dedicatedIMessageNumber,
            });
          }
          await sendQuotaPaywall({
            conversationId: msg.conversation_id,
            handle: identityHandle,
            payUrl: gate.payUrl,
          });
          return new Response(null, { status: 204 });
        }
        const ack = (async () => {
          try {
            const identity = await inkbox().getIdentity(identityHandle);
            await identity.markIMessageConversationRead(msg.conversation_id);
            await identity.sendIMessageTyping(msg.conversation_id);
          } catch (err) {
            console.error("imessage ack failed", err);
          }
        })();
        if (typeof waitUntil === "function") waitUntil(ack);
        else void ack;
      }

      const inbound = await inboundIMessageTextWithVoice(msg, transcribeVoiceNote);
      if (firstBind) {
        await sendFirstBindOnboard({
          conversationId: msg.conversation_id,
          handle: identityHandle,
          email: boundTenant?.emailAddress,
          tel: boundTenant?.dedicatedIMessageNumber,
        });
      }
      if (firstGroup) {
        await sendGroupWelcome({
          conversationId: msg.conversation_id,
          handle: identityHandle,
        });
      }
      if (inbound.allVoiceFailed) {
        if (group) return new Response(null, { status: 204 });
        console.log("imessage inbound", {
          remote,
          conversationId: msg.conversation_id,
          chars: 0,
          voice: true,
          messageType: msg.message_type,
        });
        try {
          await sendBlueIMessage({
            conversationId: msg.conversation_id,
            text: VOICE_FAILED_REPLY,
            handle: identityHandle,
          });
        } catch (err) {
          console.error("voice failed reply failed", err);
        }
        return new Response(null, { status: 204 });
      }
      if (!inbound.text) return new Response(null, { status: 204 });
      if (group && !shouldReplyInGroup(inbound.text)) {
        return new Response(null, { status: 204 });
      }
      // Group billing runs only after the mention gate so side chatter
      // cannot burn the owner's daily quota or paywall the group.
      if (group) {
        const gate = await inboundOwnerGate(ownerPhone);
        if (gate.decision === "drop") {
          return new Response(null, { status: 204 });
        }
        if (gate.decision === "paywall") {
          await sendQuotaPaywall({
            conversationId: msg.conversation_id,
            handle: identityHandle,
            payUrl: gate.payUrl,
          });
          return new Response(null, { status: 204 });
        }
      }
      if (isHelpAsk(inbound.text)) {
        await sendHelpCatalog({
          conversationId: msg.conversation_id,
          handle: identityHandle,
          canJoinGroups: Boolean(
            boundTenant?.dedicatedIMessageNumber ??
              tenant?.dedicatedIMessageNumber,
          ),
        });
      }
      if (isTelegramAsk(inbound.text)) {
        try {
          await sendTelegramInvite({
            conversationId: msg.conversation_id,
            handle: identityHandle,
            phone: remote,
          });
        } catch (err) {
          console.error("telegram invite failed", err);
        }
      }
      if (shouldSkipAgentTurn({ firstBind, text: inbound.text })) {
        return new Response(null, { status: 204 });
      }
      const touch = touchLastChannel(remote, "imessage").catch((err) =>
        console.error("touch last channel failed", err),
      );
      if (typeof waitUntil === "function") waitUntil(touch);
      else void touch;
      const rawContent = await inboundUserContent(inbound.text, msg.media);
      const content = group
        ? tagGroupUserContent(remote, rawContent)
        : rawContent;
      console.log("imessage inbound", {
        remote,
        ownerPhone,
        group,
        conversationId: msg.conversation_id,
        chars: inbound.text.length,
        voice: inbound.voice,
        images: typeof content === "string" ? 0 : content.length - 1,
        messageType: msg.message_type,
      });

      parkTurn(
        waitUntil,
        from(msg.conversation_id).send(content, {
          auth: {
            authenticator: "inkbox",
            issuer: "inkbox",
            principalType: "user",
            principalId: ownerPhone,
            attributes: group
              ? groupAuthAttributes({
                  conversationId: msg.conversation_id,
                  inkboxHandle: identityHandle,
                  messageId: msg.id,
                  origin: "human",
                  senderPhone: remote,
                  ownerPhone,
                })
              : {
                  conversationId: msg.conversation_id,
                  inkboxHandle: identityHandle,
                  messageId: msg.id,
                  origin: "human",
                },
          },
        }),
      );

      return new Response(null, { status: 204 });
    }),
    POST("/webhooks/mail", async (request, { from }) => {
      const got = await ingestInboundMail(request);
      if ("drop" in got) {
        if (got.status === 401) return new Response("unauthorized", { status: 401 });
        if (got.status === 500) {
          return new Response(got.drop, { status: 500 });
        }
        console.log("mail inbound dropped", got.drop);
        return new Response(null, { status: 204 });
      }
      console.log("mail inbound", {
        remote: got.phone,
        conversationId: got.conversationId,
        chars: got.text.length,
      });
      await from(got.conversationId).send(got.text, {
        auth: {
          authenticator: "inkbox",
          issuer: "inkbox",
          principalType: "user",
          principalId: got.phone,
          attributes: {
            conversationId: got.conversationId,
            inkboxHandle: got.handle,
            origin: "human",
          },
        },
      });
      return new Response(null, { status: 204 });
    }),
    POST("/internal/memory-sync", async (request) => {
      let body: { secret?: unknown; tenantPhone?: unknown; sinceMs?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const expected = process.env.BRO_INTERNAL_SECRET;
      if (!expected || body.secret !== expected) {
        return new Response("unauthorized", { status: 401 });
      }
      const tenantPhone =
        typeof body.tenantPhone === "string" ? body.tenantPhone : "";
      if (!tenantPhone) {
        return new Response("missing tenantPhone", { status: 400 });
      }
      const sinceMs = typeof body.sinceMs === "number" ? body.sinceMs : undefined;
      try {
        const result = await syncTenantArchive(tenantPhone, sinceMs);
        return Response.json({ ok: true, ...result });
      } catch (err) {
        console.error("memory sync failed", tenantPhone, err);
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }),
    // Drop a session's model history. Needed once per session that received a
    // photo before 2026-09-06: eve keeps Uint8Array file parts in history (the
    // workflow serializer round-trips them) and every memory-tool closure then
    // fails "Expected a JSON-serializable value" on each later turn. Long-term
    // memory lives in Convex/Supermemory and survives the clear.
    POST("/internal/session-clear", async (request, { from }) => {
      let body: { secret?: unknown; conversationId?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const expected = process.env.BRO_INTERNAL_SECRET;
      if (!expected || body.secret !== expected) {
        return new Response("unauthorized", { status: 401 });
      }
      const conversationId =
        typeof body.conversationId === "string" ? body.conversationId : "";
      if (!conversationId) {
        return new Response("missing conversationId", { status: 400 });
      }
      const result = await from(conversationId).clear();
      console.log("session cleared", { conversationId, result });
      return Response.json({ ok: true, result });
    }),
    POST("/internal/wakeup", async (request, { from }) => {
      let body: {
        secret?: unknown;
        kind?: unknown;
        payload?: unknown;
        conversationId?: unknown;
        tenantPhone?: unknown;
        inkboxHandle?: unknown;
        lastSeen?: unknown;
        idempotencyKey?: unknown;
        runId?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const expected = process.env.BRO_INTERNAL_SECRET;
      if (!expected || body.secret !== expected) {
        return new Response("unauthorized", { status: 401 });
      }
      const conversationId =
        typeof body.conversationId === "string" ? body.conversationId : "";
      const tenantPhone =
        typeof body.tenantPhone === "string" ? body.tenantPhone : "";
      if (!conversationId || !tenantPhone) {
        return new Response("missing fields", { status: 400 });
      }
      const kind = typeof body.kind === "string" ? body.kind : "";
      const payload = typeof body.payload === "string" ? body.payload : "";
      const inkboxHandle =
        typeof body.inkboxHandle === "string" ? body.inkboxHandle : undefined;
      const lastSeen =
        typeof body.lastSeen === "string" ? body.lastSeen : undefined;
      // ponytail: у reminder нет [SILENT] — напоминание доставляется всегда,
      // иначе слабая модель молчит «на всякий случай».
      let prompt = `[background wakeup] Напоминание для человека: ${payload}. Сейчас ${new Date().toISOString()}. Передай его одним коротким сообщением от своего лица.`;
      if (kind === "brief") {
        prompt =
          "[background wakeup] Утренний бриф. Собери коротко: (1) память об этом человеке — незакрытые дела/напоминания на сегодня; (2) если подключён Gmail/Calendar через Composio — новые важные письма и встречи сегодня; (3) статус браузер-джоба, если был. Если по ВСЕМ пунктам пусто — ответь [SILENT]. Одно короткое сообщение, без воды.";
      } else if (kind === "watcher") {
        prompt = watcherWakeupPrompt(payload, lastSeen);
      } else if (kind === "browser_poll") {
        prompt = `[background wakeup] Проверь статус текущего браузер-джоба вызовом тула browser_task с task=${payload}. Если completed — отправь человеку результаты. Если failed или джоб завис — коротко скажи об этом. Если ещё работает — ответь [SILENT].`;
        if (wakeupCarriesRunId(body.runId)) {
          let tenant;
          try {
            tenant = await getTenant(tenantPhone);
          } catch {
            return new Response("tenant lookup failed", { status: 503 });
          }
          if (tenant?.browserRunId !== body.runId) {
            return Response.json({ ok: true, skipped: "stale_run" });
          }
          // Residual race: browserRunId can change during from().send after this check.
        }
      } else if (kind === "job_check") {
        prompt = `[background wakeup] Фоновая проверка джоба: ${payload}. Открытые джобы этого человека уже в контексте. Сделай следующий шаг цепочки сам (проверь почту/статус нужным тулом: composio, browser_task, bro_mail, otp_lookup). Если ждёшь OTP — сначала inbox/archive, в тред только если письма нет. Если есть прогресс — сделай шаг и коротко напиши человеку. Если продвинуться нечем — ответь ровно [SILENT]: проверка повторится сама. Если джоб уже закрыт или отменён — вызови cancel_wakeup с kind=job_check и payloadContains «джоб <id>», затем ответь [SILENT].`;
      } else if (kind === "event") {
        prompt = eventPrompt(payload);
      }
      const idempotencyKey =
        typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
      if (
        idempotencyKey &&
        !takeWakeupDelivery(wakeupDelivered, idempotencyKey, Date.now())
      ) {
        return Response.json({ ok: true, duplicate: true });
      }
      try {
        await from(conversationId).send(prompt, {
          auth: {
            authenticator: "inkbox",
            issuer: "inkbox",
            principalType: "user",
            principalId: tenantPhone,
            // ponytail: wire v1 не терпит undefined в attributes — ключ опускаем
            attributes: inkboxHandle
              ? { conversationId, inkboxHandle, origin: "wakeup", wakeupKind: kind }
              : { conversationId, origin: "wakeup", wakeupKind: kind },
          },
        });
      } catch (err) {
        if (idempotencyKey) {
          releaseWakeupDelivery(wakeupDelivered, idempotencyKey);
        }
        throw err;
      }
      return Response.json({ ok: true });
    }),
  ],
  events: {
    async "turn.failed"(event, channel, ctx) {
      const conversationId = channel.continuation?.token;
      if (!conversationId) return;
      console.error("turn failed", { conversationId, code: event.code, message: event.message });
      const auth = ctx?.session?.auth?.current;
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
    async "message.completed"(event, channel, ctx) {
      const conversationId = channel.continuation?.token;
      if (!conversationId) return;
      const auth = ctx?.session?.auth?.current;
      const origin = turnOrigin(auth?.attributes);
      const planned = planTurnDelivery({
        finishReason: event.finishReason,
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
  },
});
