import { defineChannel, GET, POST } from "eve/channels";
import type { IMessageWebhookPayload } from "@inkbox/sdk";
import {
  agentHandle,
  handleFromRequest,
  isBlueIMessage,
  sendBlueIMessage,
  webhookOk,
} from "../lib/inkbox";
import {
  bindPhotonInbound,
  countInboundMessage,
  getTenant,
  getTenantByConversation,
  getTenantByHandle,
  loadWakeContext,
  markPaywallSent,
  markPhotonNudgeSent,
  mintTelegramBind,
  touchLastChannel,
  upsertTenant,
} from "../lib/convex";
import { prefetchInstinctRecall } from "../lib/instinct-recall.ts";
import { prefetchOpenRouter } from "../lib/openrouter-warm.ts";
import { shortAckAttribute } from "../lib/short-ack.ts";
import {
  helpText,
  isHelpAsk,
  isTelegramAsk,
  shouldSkipAgentTurn,
  welcomeBubbles,
} from "../lib/onboard-policy";
import { ingestInboundMail } from "../lib/mail-inbound";
import {
  connectCardHtml,
  isConnectDest,
} from "../lib/connect-link";
import { inboundIMessageText } from "../lib/imessage-text";
import { parkTurn } from "../lib/channel-turn.ts";
import { parkLastChannelTouch } from "../lib/early-deliver.ts";
import { jobCheckWakePrompt } from "../lib/job-wake.ts";
import { imessageDeliveryEvents } from "../lib/turn-delivery-events.ts";
import { telegramBindLink } from "../../convex/lib/telegramPolicy.ts";
import { telegramBotUsername } from "../lib/telegram";
import { assembleInboundContent } from "../lib/inbound-image.ts";
import { savePhotonInboundFiles } from "../lib/inbound-files.ts";
import { canSkipInboundBind } from "../lib/inbound-bind.ts";
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
  photonWebhookOk,
  readPhotonInbound,
  sendPhotonText,
} from "../lib/photon.ts";
import {
  isBluePhotonService,
  photonNudgeText,
  refuseSmsText,
  shouldNudgeInkboxThread,
} from "../../convex/lib/photonPolicy.ts";

// ponytail: in-memory only — lost on restart, not shared across instances
const wakeupDelivered = new Map<string, number>();

async function sendFirstBindOnboard(opts: {
  conversationId: string;
}): Promise<void> {
  try {
    for (const text of welcomeBubbles()) {
      await sendPhotonText({
        conversationId: opts.conversationId,
        text,
      });
    }
  } catch (err) {
    console.error("onboard welcome failed", err);
  }
}

async function sendHelpCatalog(opts: { conversationId: string }): Promise<void> {
  try {
    await sendPhotonText({
      conversationId: opts.conversationId,
      text: helpText(),
    });
  } catch (err) {
    console.error("help catalog failed", err);
  }
}

async function sendTelegramInvite(opts: {
  conversationId: string;
  phone: string;
}): Promise<void> {
  const bot = telegramBotUsername();
  if (!bot) {
    await sendPhotonText({
      conversationId: opts.conversationId,
      text: "Telegram у Bro ещё не включён.",
    });
    return;
  }
  const minted = await mintTelegramBind(opts.phone);
  if (!minted.ok) {
    await sendPhotonText({
      conversationId: opts.conversationId,
      text: "Сначала напиши Bro в этот чат как обычно, потом «телеграм».",
    });
    return;
  }
  const url = telegramBindLink(bot, minted.token);
  const text = minted.alreadyLinked
    ? `Чтобы переподключить Telegram, открой:\n${url}`
    : `Открой Telegram — тот же Bro, почта и поручения общие:\n${url}`;
  await sendPhotonText({
    conversationId: opts.conversationId,
    text,
  });
}

function prefetchOneToOneStart(phone: string, preview: string): void {
  if (!phone.trim() || !preview) return;
  void loadWakeContext(phone).catch((err) =>
    console.error("wake prefetch failed", err),
  );
  prefetchInstinctRecall(phone, preview);
  prefetchOpenRouter();
}

export async function inboundOwnerGate(ownerPhone: string): Promise<{
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
    await sendPhotonText({
      conversationId: opts.conversationId,
      text: line,
    });
  } catch (err) {
    console.error("paywall send failed", err);
  }
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
    POST("/internal/photon-send", async (request) => {
      let body: { secret?: unknown; conversationId?: unknown; text?: unknown };
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
        typeof body.conversationId === "string" ? body.conversationId.trim() : "";
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!conversationId || !text) {
        return new Response("conversationId and text required", { status: 400 });
      }
      await sendPhotonText({ conversationId, text });
      return Response.json({ ok: true });
    }),
    POST("/webhooks/photon", async (request, { from, waitUntil }) => {
      const secret = process.env.SPECTRUM_WEBHOOK_SECRET?.trim();
      if (!secret) {
        return new Response("missing SPECTRUM_WEBHOOK_SECRET", { status: 500 });
      }
      const payload = Buffer.from(await request.arrayBuffer());
      if (!photonWebhookOk(payload, request.headers, secret)) {
        return new Response("unauthorized", { status: 401 });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString()) as unknown;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const inbound = readPhotonInbound(parsed);
      if (!inbound || inbound.isEcho) return new Response(null, { status: 204 });
      if (!isBluePhotonService({ service: inbound.service })) {
        try {
          await sendPhotonText({
            conversationId: inbound.spaceId,
            text: refuseSmsText(),
          });
        } catch (err) {
          console.error("[photon] refuse sms failed", err);
        }
        return new Response(null, { status: 204 });
      }

      const preview = inbound.text;
      prefetchOpenRouter();
      if (inbound.senderPhone && preview) {
        prefetchOneToOneStart(inbound.senderPhone, preview);
      }

      const known = await getTenant(inbound.senderPhone).catch(() => null);
      // Closed beta: first DMs from any new number must bind. ALLOWED_SENDERS
      // is not a product gate (instant-access spec). bindPhotonInbound creates
      // the tenant when missing — do not drop unknown senders here.
      if (!known && inbound.senderPhone) {
        try {
          await upsertTenant(inbound.senderPhone);
        } catch (err) {
          console.error("photon tenant upsert failed", err);
        }
      }

      const boundOneToOne = canSkipInboundBind(
        known,
        inbound.senderPhone,
        inbound.spaceId,
      );
      const bound = boundOneToOne && known
        ? { ok: true as const, tenant: known, firstBind: false }
        : await bindPhotonInbound({
            phoneE164: inbound.senderPhone,
            photonConversationId: inbound.spaceId,
            photonUserId: inbound.userId,
            photonAssignedNumber: inbound.assignedPhoneNumber,
          }).catch((err) => {
            console.error("bind photon inbound failed", err);
            return { ok: false as const, reason: "error" };
          });
      if (!bound.ok) {
        console.error("dropped photon inbound", bound.reason, inbound.senderPhone);
        return new Response(null, { status: 204 });
      }

      const firstBind = bound.firstBind;
      const boundTenant = bound.tenant;
      const ownerPhone = bound.tenant.phoneE164 ?? inbound.senderPhone;
      parkTurn(
        waitUntil,
        savePhotonInboundFiles(ownerPhone, parsed).catch((err) =>
          console.error("photon inbound file save failed", err),
        ),
      );
      if (boundTenant.status === "disabled") {
        return new Response(null, { status: 204 });
      }

      const knownOwnerPhone =
        boundTenant.phoneE164 === inbound.senderPhone
          ? boundTenant.phoneE164
          : undefined;
      const earlyGateP = knownOwnerPhone && preview
        ? inboundOwnerGate(knownOwnerPhone)
        : undefined;

      if (!preview) {
        if (firstBind) {
          await sendFirstBindOnboard({ conversationId: inbound.spaceId });
        }
        return new Response(null, { status: 204 });
      }

      prefetchOneToOneStart(ownerPhone, preview);
      const gate = await (earlyGateP ?? inboundOwnerGate(ownerPhone));
      if (gate.decision === "drop") {
        return new Response(null, { status: 204 });
      }
      if (gate.decision === "paywall") {
        if (firstBind) {
          await sendFirstBindOnboard({ conversationId: inbound.spaceId });
        }
        await sendQuotaPaywall({
          conversationId: inbound.spaceId,
          handle: boundTenant.inkboxHandle ?? agentHandle(),
          payUrl: gate.payUrl,
        });
        return new Response(null, { status: 204 });
      }

      if (firstBind) {
        const onboard = sendFirstBindOnboard({ conversationId: inbound.spaceId });
        if (shouldSkipAgentTurn({ firstBind, text: inbound.text })) {
          await onboard;
        } else {
          parkTurn(waitUntil, onboard);
        }
      }
      if (isHelpAsk(inbound.text)) {
        await sendHelpCatalog({ conversationId: inbound.spaceId });
      }
      if (isTelegramAsk(inbound.text)) {
        try {
          await sendTelegramInvite({
            conversationId: inbound.spaceId,
            phone: inbound.senderPhone,
          });
        } catch (err) {
          console.error("telegram invite failed", err);
        }
      }
      if (shouldSkipAgentTurn({ firstBind, text: inbound.text })) {
        return new Response(null, { status: 204 });
      }
      prefetchInstinctRecall(ownerPhone, inbound.text);
      parkLastChannelTouch(waitUntil, touchLastChannel(inbound.senderPhone, "imessage"));
      const content = assembleInboundContent(inbound.text, []);
      console.log("photon inbound", {
        remote: inbound.senderPhone,
        ownerPhone,
        conversationId: inbound.spaceId,
        chars: inbound.text.length,
      });

      parkTurn(
        waitUntil,
        from(inbound.spaceId).send(content, {
          auth: {
            authenticator: "photon",
            issuer: "photon",
            principalType: "user",
            principalId: ownerPhone,
            attributes: {
              conversationId: inbound.spaceId,
              inkboxHandle: boundTenant.inkboxHandle ?? agentHandle(),
              ...(inbound.messageId ? { messageId: inbound.messageId } : {}),
              origin: "human",
              ...shortAckAttribute(inbound.text),
            },
          },
        }),
      );
      return new Response(null, { status: 204 });
    }),
    POST("/webhooks/imessage", async (request) => {
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

      if (body.event_type !== "imessage.received") {
        return new Response(null, { status: 204 });
      }

      const msg = body.data.message;
      if (!msg || msg.direction !== "inbound") {
        return new Response(null, { status: 204 });
      }
      if (msg.is_group) {
        return new Response(null, { status: 204 });
      }
      if (
        !isBlueIMessage({
          service: msg.service,
          wasDowngraded: msg.was_downgraded,
        })
      ) {
        return new Response(null, { status: 204 });
      }

      const conversationId = msg.conversation_id;
      if (!conversationId) return new Response(null, { status: 204 });
      const preview = inboundIMessageText(msg);
      if (!preview) return new Response(null, { status: 204 });

      const found =
        tenant ??
        (await getTenantByConversation(conversationId).catch(() => null));
      if (!found) return new Response(null, { status: 204 });
      const action = shouldNudgeInkboxThread({
        photonConversationId: found.photonConversationId,
        photonNudgeSentAt: found.photonNudgeSentAt,
      });
      if (action !== "nudge") return new Response(null, { status: 204 });

      const identityHandle = handle ?? found.inkboxHandle ?? agentHandle();
      try {
        await sendBlueIMessage({
          conversationId,
          text: photonNudgeText(found.photonAssignedNumber),
          handle: identityHandle,
        });
        await markPhotonNudgeSent(conversationId);
      } catch (err) {
        console.error("[imessage] photon nudge failed", err);
      }
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
        prompt = jobCheckWakePrompt(payload);
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
            attributes: {
              conversationId,
              origin: "wakeup",
              wakeupKind: kind,
              ...(kind === "job_check" && payload ? { wakeupPayload: payload } : {}),
              ...(inkboxHandle ? { inkboxHandle } : {}),
            },
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
  events: imessageDeliveryEvents,
});
