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
  attachCabinetLogin,
  bindPhotonInbound,
  countInboundMessage,
  getTenant,
  getTenantByConversation,
  getTenantByHandle,
  listTestBubbles,
  loadWakeContext,
  markPaywallSent,
  markPhotonNudgeSent,
  mintTelegramBind,
  resetTestTenant,
  touchLastChannel,
  upsertTenant,
} from "../lib/convex";
import { prefetchInstinctRecall } from "../lib/instinct-recall.ts";
import { prefetchOpenRouter } from "../lib/openrouter-warm.ts";
import { shortAckAttribute } from "../lib/short-ack.ts";
import {
  fastAckAttribute,
  fastAckBudgetMs,
  settleFastAck,
  startFastAck,
} from "../lib/fast-ack.ts";
import { cloudInjectAttribute } from "../../convex/lib/browserInjectPolicy.ts";
import { secretEquals } from "../lib/secret-compare.ts";
import {
  cabinetBaseUrl,
  isTelegramAsk,
  shouldSendWelcome,
  shouldSkipAgentTurn,
  welcomeBubbles,
} from "../lib/onboard-policy";
import { storedHandle } from "../../convex/lib/cabinetPolicy";
import { ingestInboundMail } from "../lib/mail-inbound";
import {
  connectCardHtml,
  isConnectDest,
} from "../lib/connect-link";
import { inboundIMessageText } from "../lib/imessage-text";
import { parkTurn } from "../lib/channel-turn.ts";
import { deliverHumanRouted } from "../lib/deliver-routed.ts";
import { inboundAtAttribute } from "../lib/latency-log.ts";
import { parkLastChannelTouch } from "../lib/early-deliver.ts";
import { jobCheckWakePrompt } from "../lib/job-wake.ts";
import { runInstinctScan, noteInstinctSources } from "../lib/instinct-wake.ts";
import { imessageDeliveryEvents } from "../lib/turn-delivery-events.ts";
import { telegramBindLink } from "../../convex/lib/telegramPolicy.ts";
import { telegramBotUsername } from "../lib/telegram";
import {
  assembleInboundContent,
  PHOTO_ONLY_TEXT,
  prefetchImageParts,
} from "../lib/inbound-image.ts";
import {
  photonInboundImages,
  savePhotonInboundFiles,
} from "../lib/inbound-files.ts";
import { canSkipInboundBind } from "../lib/inbound-bind.ts";
import { watcherWakeupPrompt } from "../lib/purchase-policy";
import { wakeupCarriesRunId } from "../../convex/lib/browserFollowPolicy.ts";
import {
  doneLineHint,
  humanLineForNeed,
  parseCloudOutcome,
  type CloudNeed,
} from "../../convex/lib/browserOutcomePolicy.ts";
import {
  releaseWakeupDelivery,
  takeWakeupDelivery,
} from "../lib/wakeup-dedupe";
import { claimDurableWakeupDelivery } from "../lib/convex";
import { deliverHuman } from "../lib/deliver-human.ts";
import {
  isTestPhone,
  testSpaceId,
} from "../../convex/lib/testTenantPolicy.ts";
import { inboundGateFromResult } from "../../convex/lib/billingPolicy";
import { eventPrompt } from "../../convex/lib/watcherPolicy.ts";
import { syncTenantArchive } from "../lib/archive-sync.ts";
import {
  photonWebhookOk,
  prefetchSpectrum,
  readPhotonInbound,
  sendPhotonText,
  sendPhotonTyping,
} from "../lib/photon.ts";
import {
  isBluePhotonService,
  photonNudgeText,
  refuseSmsText,
  shouldNudgeInkboxThread,
} from "../../convex/lib/photonPolicy.ts";

// ponytail: in-memory only — lost on restart, not shared across instances
const wakeupDelivered = new Map<string, number>();

/** Same two-step dedupe (in-memory fast path + durable cross-instance
 *  backstop) the main /internal/wakeup delivery below already applies to its
 *  idempotencyKey, factored out so the stale-run late-outcome notice can
 *  share it under its own key. */
async function claimWakeupOnce(key: string): Promise<boolean> {
  if (!key) return true;
  if (!takeWakeupDelivery(wakeupDelivered, key, Date.now())) return false;
  try {
    const durable = await claimDurableWakeupDelivery(key);
    if (!durable.taken) return false;
  } catch (err) {
    console.error("durable wakeup dedupe check failed", err);
  }
  return true;
}

async function cabinetHandleForWelcome(opts: {
  phone: string;
  inkboxHandle?: string;
  inkboxIdentityId?: string;
  photonUserId?: string;
}): Promise<string | undefined> {
  const existing = storedHandle(opts.inkboxHandle);
  if (existing) return existing;
  const identityId = opts.inkboxIdentityId?.trim() || opts.photonUserId?.trim() || "photon";
  try {
    const minted = await attachCabinetLogin({
      phoneE164: opts.phone,
      identityId,
    });
    return storedHandle(minted.handle) ?? undefined;
  } catch (err) {
    console.error("cabinet handle attach failed", err);
    return undefined;
  }
}

async function sendWelcomeLetter(opts: {
  conversationId: string;
  phone: string;
  inkboxHandle?: string;
  inkboxIdentityId?: string;
  photonUserId?: string;
}): Promise<void> {
  const handle = await cabinetHandleForWelcome(opts);
  try {
    for (const text of welcomeBubbles({
      handle,
      cabinetBase: cabinetBaseUrl(),
    })) {
      await sendPhotonText({
        conversationId: opts.conversationId,
        text,
      });
    }
  } catch (err) {
    console.error("onboard welcome failed", err);
  }
}

async function sendTelegramInvite(opts: {
  conversationId: string;
  phone: string;
}): Promise<void> {
  const bot = telegramBotUsername();
  if (!bot) {
    // A deployment without TELEGRAM_BOT_USERNAME tells every person who asks
    // that the second channel is off, and used to do it without a single log
    // line — so the only place the misconfiguration showed up was a human's
    // chat. Say it in the log too, by the name of the variable to set.
    console.error("telegram invite impossible: TELEGRAM_BOT_USERNAME is not set");
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
    // Keep-warm ping (Convex cron): boots the cached Spectrum app and the
    // OpenRouter connection so the first human turn after a quiet spell
    // does not pay the cold-start bill. Secret-gated: each boot costs Photon
    // HTTP calls.
    POST("/internal/warm", async (request) => {
      let body: { secret?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!secretEquals(body.secret, process.env.BRO_INTERNAL_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      prefetchSpectrum();
      prefetchOpenRouter();
      return Response.json({ ok: true });
    }),
    POST("/internal/photon-send", async (request) => {
      let body: { secret?: unknown; conversationId?: unknown; text?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!secretEquals(body.secret, process.env.BRO_INTERNAL_SECRET)) {
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
      const receivedAt = Date.now();
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
      const received = readPhotonInbound(parsed);
      if (!received || received.isEcho) return new Response(null, { status: 204 });
      if (!isBluePhotonService({ service: received.service })) {
        try {
          await sendPhotonText({
            conversationId: received.spaceId,
            text: refuseSmsText(),
          });
        } catch (err) {
          console.error("[photon] refuse sms failed", err);
        }
        return new Response(null, { status: 204 });
      }

      // A photo rides in the attachments, never in `content.text`: with a
      // caption the webhook sends `{ type: "text", text, attachments: [...] }`,
      // without one `{ type: "file", url }`. Reading only the text is why Bro
      // answered «найди эту книгу» blind — the picture was never in the turn —
      // and why a photo with nothing written under it looked like an empty
      // message and was dropped a few lines down.
      const images = photonInboundImages(parsed);
      const photoP = images.length > 0
        ? prefetchImageParts(images).catch((err) => {
            console.error("photon inbound image fetch failed", err);
            return [];
          })
        : undefined;
      const inbound = images.length > 0 && !received.text
        ? { ...received, text: PHOTO_ONLY_TEXT }
        : received;

      const preview = inbound.text;
      prefetchOpenRouter();
      // Fast-ack lane: a tiny no-reasoning model call turns this message into
      // a 2-5 word status line and sends it as the first bubble within a
      // hard budget, well before the real agent turn (a different Vercel
      // function) could produce one. Started this early so the round trip
      // overlaps everything below instead of adding to the wait.
      const fastAck = preview ? startFastAck(preview) : null;
      const cancelFastAck = () => fastAck?.abort();
      // «печатает…» goes out before any Convex hop: the human sees Bro is
      // alive within the Photon round trip, not after the first token.
      if (preview && !shouldSkipAgentTurn({ firstBind: false, text: preview })) {
        parkTurn(
          waitUntil,
          sendPhotonTyping({ conversationId: inbound.spaceId }),
        );
      } else {
        prefetchSpectrum();
      }
      if (inbound.senderPhone && preview) {
        prefetchOneToOneStart(inbound.senderPhone, preview);
      }
      // Billing count and tenant lookup are independent Convex hops; run
      // them side by side. The count is reused below when the sender owns
      // the thread (always, for a 1:1), and recomputed otherwise.
      const senderGateP =
        inbound.senderPhone && preview
          ? inboundOwnerGate(inbound.senderPhone)
          : undefined;

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
        cancelFastAck();
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
        cancelFastAck();
        return new Response(null, { status: 204 });
      }

      const knownOwnerPhone =
        boundTenant.phoneE164 === inbound.senderPhone
          ? boundTenant.phoneE164
          : undefined;
      const earlyGateP = knownOwnerPhone && preview
        ? (senderGateP ?? inboundOwnerGate(knownOwnerPhone))
        : undefined;

      if (!preview) {
        if (firstBind) {
          await sendWelcomeLetter({
            conversationId: inbound.spaceId,
            phone: inbound.senderPhone,
            inkboxHandle: boundTenant.inkboxHandle,
            inkboxIdentityId: boundTenant.inkboxIdentityId,
            photonUserId: inbound.userId,
          });
        }
        return new Response(null, { status: 204 });
      }

      prefetchOneToOneStart(ownerPhone, preview);
      const gate = await (earlyGateP ?? inboundOwnerGate(ownerPhone));
      if (gate.decision === "drop") {
        cancelFastAck();
        return new Response(null, { status: 204 });
      }
      if (gate.decision === "paywall") {
        if (firstBind) {
          await sendWelcomeLetter({
            conversationId: inbound.spaceId,
            phone: inbound.senderPhone,
            inkboxHandle: boundTenant.inkboxHandle,
            inkboxIdentityId: boundTenant.inkboxIdentityId,
            photonUserId: inbound.userId,
          });
        }
        await sendQuotaPaywall({
          conversationId: inbound.spaceId,
          handle: boundTenant.inkboxHandle ?? agentHandle(),
          payUrl: gate.payUrl,
        });
        cancelFastAck();
        return new Response(null, { status: 204 });
      }

      // The letter is a first-contact thing: once on the bind, and after that
      // only when a human asks for it by name. A repeat «привет» falls through
      // to the ordinary agent turn below.
      if (shouldSendWelcome({ firstBind, text: inbound.text })) {
        const onboard = sendWelcomeLetter({
          conversationId: inbound.spaceId,
          phone: inbound.senderPhone,
          inkboxHandle: boundTenant.inkboxHandle,
          inkboxIdentityId: boundTenant.inkboxIdentityId,
          photonUserId: inbound.userId,
        });
        if (firstBind && !shouldSkipAgentTurn({ firstBind, text: inbound.text })) {
          parkTurn(waitUntil, onboard);
        } else {
          await onboard;
        }
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
        cancelFastAck();
        return new Response(null, { status: 204 });
      }
      prefetchInstinctRecall(ownerPhone, inbound.text);
      parkLastChannelTouch(waitUntil, touchLastChannel(inbound.senderPhone, "imessage"));
      const photoParts = photoP ? await photoP : [];
      const content = assembleInboundContent(inbound.text, photoParts);
      console.log("photon inbound", {
        remote: inbound.senderPhone,
        ownerPhone,
        conversationId: inbound.spaceId,
        chars: inbound.text.length,
        images: photoParts.length,
        queuedAfterMs: Date.now() - receivedAt,
      });

      const ackText = await settleFastAck(fastAck, { budgetMs: fastAckBudgetMs() });
      if (ackText) {
        parkTurn(
          waitUntil,
          deliverHumanRouted({
            attrs: {
              conversationId: inbound.spaceId,
              inkboxHandle: boundTenant.inkboxHandle ?? agentHandle(),
              origin: "human",
            },
            tenant: boundTenant,
            conversationId: inbound.spaceId,
            text: ackText,
            principalId: ownerPhone,
            // Test tenants only: lets a scenario tell the pre-turn status
            // line apart from the turn's own first bubble, so "it answered"
            // cannot be satisfied by the ack alone.
            note: "fast-ack",
          }).catch((err) => console.error("fast ack deliver failed", err)),
        );
        console.log("fast ack sent", {
          conversationId: inbound.spaceId,
          chars: ackText.length,
          sinceInboundMs: Date.now() - receivedAt,
        });
      }
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
              ...inboundAtAttribute(receivedAt),
              ...fastAckAttribute(ackText),
              ...cloudInjectAttribute(inbound.text),
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
            origin: "wakeup",
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
      if (!secretEquals(body.secret, process.env.BRO_INTERNAL_SECRET)) {
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
      if (!secretEquals(body.secret, process.env.BRO_INTERNAL_SECRET)) {
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
    // Cloud testing (docs: README "Cloud testing"). Inbound needs no route of
    // its own — a scenario signs a synthetic Photon payload and posts it to
    // the real /webhooks/photon, so the suite exercises the production path
    // rather than a copy. These two only cover what a test cannot do from
    // outside: read back what Bro said, and put a tenant back to a clean
    // slate. Both refuse any phone outside the fictional test range, on this
    // side and again inside Convex.
    POST("/internal/test/transcript", async (request) => {
      let body: { secret?: unknown; phone?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!secretEquals(body.secret, process.env.BRO_INTERNAL_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      if (!isTestPhone(phone)) {
        return new Response("not a test phone", { status: 400 });
      }
      return Response.json({ ok: true, bubbles: await listTestBubbles(phone) });
    }),
    POST("/internal/test/reset", async (request, { from }) => {
      let body: { secret?: unknown; phone?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!secretEquals(body.secret, process.env.BRO_INTERNAL_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      if (!isTestPhone(phone)) {
        return new Response("not a test phone", { status: 400 });
      }
      const cleared = await resetTestTenant(phone);
      // The model's own history lives in eve, not Convex: without this a
      // second run of the same scenario starts mid-conversation and the
      // welcome-letter and greeting branches never fire again.
      const session = await from(testSpaceId(phone)).clear();
      console.log("test tenant reset", { phone, ...cleared });
      return Response.json({ ok: true, cleared, session });
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
        phase?: unknown;
        need?: unknown;
        needDetail?: unknown;
        result?: unknown;
        liveUrl?: unknown;
        nextTask?: unknown;
        site?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!secretEquals(body.secret, process.env.BRO_INTERNAL_SECRET)) {
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
      // A2: browser_poll now carries a resolved phase — the wakeup route
      // builds the exact turn, the model reports it without calling
      // browser_task again (the result already lives in the payload).
      let wakeupPhase: string | undefined;
      let wakeupFallback: string | undefined;
      /** What an `instinct` turn is about — marked as seen once it is handed
       *  to the model, so the next scan half an hour later does not offer the
       *  same meeting again whether or not the model chose to speak. */
      let instinctSources: string[] = [];
      if (kind === "brief") {
        prompt =
          "[background wakeup] Утренний бриф. Собери коротко: (1) память об этом человеке — незакрытые дела/напоминания на сегодня; (2) если подключён Gmail/Calendar через Composio — новые важные письма и встречи сегодня; (3) статус браузер-джоба, если был. Если по ВСЕМ пунктам пусто — ответь [SILENT]. Одно короткое сообщение, без воды.";
      } else if (kind === "watcher") {
        prompt = watcherWakeupPrompt(payload, lastSeen);
      } else if (kind === "browser_poll") {
        const need = typeof body.need === "string" ? (body.need as CloudNeed) : undefined;
        const needDetail = typeof body.needDetail === "string" ? body.needDetail : undefined;
        const result = typeof body.result === "string" ? body.result : "";
        const liveUrl = typeof body.liveUrl === "string" ? body.liveUrl : undefined;
        const nextTask = typeof body.nextTask === "string" ? body.nextTask : undefined;
        const site = typeof body.site === "string" ? body.site : undefined;
        const phase =
          body.phase === "done" ||
          body.phase === "need" ||
          body.phase === "failed" ||
          body.phase === "giveup"
            ? body.phase
            : undefined;

        if (wakeupCarriesRunId(body.runId)) {
          let tenant;
          try {
            tenant = await getTenant(tenantPhone);
          } catch {
            return new Response("tenant lookup failed", { status: 503 });
          }
          if (tenant?.browserRunId !== body.runId) {
            // The run this webhook is about is no longer the tenant's active
            // one (reset, or a later errand already started) — normally
            // nothing to say. But a `done` phase with a real labelled outcome
            // and nothing pending means the run finished anyway; staying
            // silent would mean a completed order the person never hears
            // about (real incident: a taxi got ordered and the chat stayed
            // quiet) — worse than one redundant line. Uses the same durable
            // key as Convex's own browser_late notice (wakeups.takeDelivery)
            // so only one of the two paths ever fires for a given run.
            if (tenant && phase === "done") {
              const outcome = parseCloudOutcome(result);
              if (outcome.labelled && outcome.needs === "none") {
                const lateKey = `browser_late:${body.runId}`;
                if (await claimWakeupOnce(lateKey)) {
                  await deliverHuman({
                    tenant,
                    conversationId,
                    text: `Кстати, прошлое поручение всё же завершилось. ${doneLineHint(outcome)}`,
                  }).catch((err) => {
                    releaseWakeupDelivery(wakeupDelivered, lateKey);
                    console.error("late browser outcome deliver failed", err);
                  });
                }
              }
            }
            return Response.json({ ok: true, skipped: "stale_run" });
          }
          // Residual race: browserRunId can change during from().send after this check.
        }

        if (phase === "done") {
          wakeupPhase = phase;
          const variantsLine =
            "Если в итоге есть ВАРИАНТЫ — одно сообщение «нашёл N вариантов: …» одной строкой на вариант с ценой, ссылки не вставляй, кроме случая когда просят.";
          const nextTaskLine = nextTask
            ? ` Затем сразу начни отложенное поручение «${nextTask}»: одна короткая строка человеку и browser_task с этим текстом.`
            : "";
          prompt = `[background wakeup] Поручение «${payload}» завершено. Итог браузера:\n${result}\n\nСкажи человеку, что всё сделано, живыми словами — как другу в чат, своей формулировкой, а не заученной фразой (каждый раз по-новому, не начинай одинаково). Важное не теряй: что именно сделано, номер заказа или записи, сумма, когда и куда. 1–2 коротких пузыря, без канцелярита и без слов «джоб», «reset», «Cloud», «браузер». ${variantsLine} Не вызывай browser_task для проверки — результат уже здесь.${nextTaskLine}`;
          wakeupFallback = doneLineHint(parseCloudOutcome(result));
        } else if (phase === "need") {
          wakeupPhase = phase;
          const line = humanLineForNeed(need ?? "info", { site, liveUrl, detail: needDetail });
          if (need === "email_code") {
            prompt = `[background wakeup] Браузер остановился: нужен код с почты. Сначала вызови otp_lookup (hint: ${site ?? payload}). Если код найден — первая строка «код из почты, ввожу», затем browser_task с этим кодом. Если письма нет — отправь человеку ровно: «${line}».`;
          } else if (need === "password" && site) {
            // A known site + no vault login is exactly what profile_setup is
            // for — let it open the login page and send its own live-view
            // link, instead of the human being told a bare "нужен вход" with
            // nothing for Bro to do about it.
            prompt = `[background wakeup] Браузер остановился: нужен вход на ${site}. Вызови profile_setup с url https://${site} и errand=«${payload}» — он сам откроет вход и пришлёт ссылку; человеку ничего не пиши до его ответа.`;
          } else if (need === "payment" && site) {
            // Vault-aware first: the run may simply have started without
            // `pay` (the taxi incident) even though a card is already
            // saved. Try to finish it in the SAME session before bothering
            // the human — browser_task's payment continuation auto-binds
            // the vault card and reports needsVaultSetup only if there
            // genuinely isn't one; only then does the human need anything.
            prompt = `[background wakeup] Браузер остановился: нужна оплата на ${site}. Сначала попробуй сам: вызови browser_task с задачей «Продолжи поручение «${payload}» в текущей сессии, оплати картой из сейфа» и pay: {hosts: ["${site}"]}. Если тул вернёт needsVaultSetup — сохранённой карты нет: вызови vault_setup с kind=payment и пришли ссылку, больше ничего не пиши. Если оплата прошла — сообщи человеку «готово»-сообщением из результата. Если тул вернёт что-то другое — отправь человеку ровно: «${line}».`;
          } else {
            prompt = `[background wakeup] Браузер остановился: нужно ${need ?? "info"} (${needDetail ?? "без деталей"}). Отправь человеку ровно: «${line}». Не проси пароль. Ничего больше не делай.`;
          }
          wakeupFallback = line;
        } else if (phase === "failed") {
          wakeupPhase = phase;
          const reason = result.split(/\r?\n/)[0]?.slice(0, 200).trim();
          prompt = `[background wakeup] Поручение «${payload}» не получилось${reason ? `: ${reason}` : ""}. Скажи это одной строкой, своими словами и каждый раз по-разному — как живой человек, без извинительных шаблонов и без «к сожалению». И тут же предложи попробовать ещё раз или сделать иначе. Без слов «джоб», «reset», «Cloud».`;
          wakeupFallback = `Не получилось: ${payload}. Попробовать ещё раз?`;
        } else if (phase === "giveup") {
          wakeupPhase = phase;
          prompt = `[background wakeup] Я остановил задачу «${payload}» — она зависла на ${site ?? "сайте"}. Скажи это одной строкой, простыми словами и не по шаблону, и предложи начать заново. Без слов «джоб», «reset», «Cloud».`;
          wakeupFallback = `Задача «${payload}» зависла — я её остановил. Начать заново?`;
        } else {
          // Legacy/un-phased wakeup (older workflow build, or a webhook
          // replay from before this deploy) — keep the pre-A2 behavior so an
          // in-flight run still resolves instead of erroring out.
          prompt = `[background wakeup] Проверь статус текущего браузер-джоба вызовом тула browser_task с task=${payload}. Если человек уже прислал одноразовый код или уточнение к этой сессии, и оно ещё не введено — вызови browser_task с его точной строкой (сначала «ввожу код» / «ввожу»). Пароль не проси. Если completed — отправь человеку результаты. Если failed или джоб завис — коротко скажи об этом. Если ещё работает и инжектить нечего — ответь [SILENT].`;
        }
      } else if (kind === "job_check") {
        prompt = jobCheckWakePrompt(payload);
      } else if (kind === "instinct") {
        // Proactivity: nobody asked for this turn. The scan decides on its own
        // whether there is anything worth saying first — and most of the time
        // there is not, so the cheap exit is the normal one: answer the wakeup
        // without starting a model turn at all. The scan checks the
        // conversation budget (quiet hours, daily cap, gap, live chat) before
        // it reads any data, so a silent scan costs one Convex query.
        const scan = await runInstinctScan(tenantPhone).catch((err) => {
          console.error("instinct scan failed", err);
          return { speak: false as const, reason: "scan_failed" };
        });
        if (!scan.speak) {
          console.log("instinct scan silent", { reason: scan.reason });
          return Response.json({ ok: true, skipped: scan.reason });
        }
        prompt = scan.prompt;
        instinctSources = scan.sourceIds;
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
      if (idempotencyKey) {
        // Durable, cross-instance backstop (finding B2): the in-memory Map
        // above only protects a single warm instance. A lookup failure fails
        // open — a rare duplicate beats a wakeup that never reaches the human.
        try {
          const durable = await claimDurableWakeupDelivery(idempotencyKey);
          if (!durable.taken) {
            return Response.json({ ok: true, duplicate: true });
          }
        } catch (err) {
          console.error("durable wakeup dedupe check failed", err);
        }
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
              // The watcher's own wording travels with the turn so
              // `browser_task` can read the person's ceiling and their
              // «следи» / «следи и купи» stance from the attributes instead of
              // trusting the model to re-derive them (watcherPayDecision).
              ...((kind === "job_check" || kind === "watcher") && payload
                ? { wakeupPayload: payload }
                : {}),
              ...(wakeupPhase ? { wakeupPhase } : {}),
              ...(wakeupFallback ? { wakeupFallback } : {}),
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
      if (instinctSources.length > 0) {
        // Marked seen, not spent: the daily slot is only charged when the turn
        // actually produced a bubble, which the delivery events know and this
        // route does not (see `spendInstinctSlot` in turn-delivery-events.ts).
        await noteInstinctSources(tenantPhone, instinctSources).catch((err) =>
          console.error("instinct sources note failed", err),
        );
      }
      return Response.json({ ok: true });
    }),
    // Secret-gated same-process delivery for a channel-agnostic Convex-side
    // notify (browser follow-through login link, sweepWaiting's give-up
    // line) — honors `lastChannel` via deliverHuman, unlike cabinet.sendText.
    POST("/internal/deliver", async (request) => {
      let body: { secret?: unknown; tenantPhone?: unknown; text?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!secretEquals(body.secret, process.env.BRO_INTERNAL_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const tenantPhone =
        typeof body.tenantPhone === "string" ? body.tenantPhone : "";
      const text = typeof body.text === "string" ? body.text : "";
      if (!tenantPhone || !text) {
        return new Response("missing fields", { status: 400 });
      }
      let tenant;
      try {
        tenant = await getTenant(tenantPhone);
      } catch (err) {
        console.error("deliver tenant lookup failed", err);
        return new Response("tenant lookup failed", { status: 503 });
      }
      if (!tenant) return new Response("unknown tenant", { status: 404 });
      const conversationId = tenant.photonConversationId || tenant.inkboxConversationId;
      if (!conversationId) return Response.json({ ok: false, reason: "no conversation" });
      await deliverHuman({ tenant, conversationId, text });
      return Response.json({ ok: true });
    }),
  ],
  events: imessageDeliveryEvents,
});
