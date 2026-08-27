import { defineChannel, GET, POST } from "eve/channels";
import type { IMessageWebhookPayload } from "@inkbox/sdk";
import {
  agentHandle,
  allowlisted,
  inkbox,
  isAccessHandle,
  isBlueIMessage,
  sendBlueIMessage,
  webhookOk,
} from "../lib/inkbox";
import {
  bindInbound,
  countInboundMessage,
  getTenantByConversation,
  getTenantByHandle,
  setWakeupLastSeen,
  upsertTenant,
} from "../lib/convex";
import { ingestInboundMail } from "../lib/mail-inbound";
import {
  connectCardHtml,
  isConnectDest,
  stripConnectUrls,
} from "../lib/connect-link";
import { inboundIMessageText, toIMessageBubbles } from "../lib/imessage-text";
import { splitSeen } from "../lib/wakeup-text";

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

      const remote = msg.remote_number;
      if (!remote) {
        console.error("dropped inbound without remote number");
        return new Response(null, { status: 204 });
      }

      const identityHandle = handle ?? agentHandle();

      if (handle) {
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

      const text = inboundIMessageText(msg);
      if (!text) return new Response(null, { status: 204 });
      console.log("imessage inbound", {
        remote,
        conversationId: msg.conversation_id,
        chars: text.length,
        messageType: msg.message_type,
      });

      let gate: { decision: "allow" | "paywall" | "drop"; payUrl?: string } = {
        decision: "allow",
      };
      try {
        gate = await countInboundMessage(remote);
      } catch (err) {
        // ponytail: billing must not kill chat
        console.error("billing count failed", err);
      }
      if (gate.decision === "drop") {
        return new Response(null, { status: 204 });
      }
      if (gate.decision === "paywall") {
        const line = gate.payUrl
          ? `Лимит на сегодня исчерпан 🙈 Полный доступ — 2000 ₽/мес: ${gate.payUrl}`
          : "Лимит на сегодня исчерпан 🙈 Полный доступ — 2000 ₽/мес: напиши @оператору";
        try {
          await sendBlueIMessage({
            conversationId: msg.conversation_id,
            text: line,
            handle: identityHandle,
          });
        } catch (err) {
          console.error("paywall send failed", err);
        }
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

      await from(msg.conversation_id).send(text, {
        auth: {
          authenticator: "inkbox",
          issuer: "inkbox",
          principalType: "user",
          principalId: remote,
          attributes: {
            conversationId: msg.conversation_id,
            inkboxHandle: identityHandle,
          },
        },
      });

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
          },
        },
      });
      return new Response(null, { status: 204 });
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
        prompt = `[background wakeup] Сторож: ${payload}.
Прошлое состояние: ${lastSeen ?? "ничего"}. Проверь текущее состояние (Composio-тулы или browser_task — что уместно). Если НИЧЕГО нового относительно прошлого состояния — ответь ровно [SILENT]. Если есть новое — одно короткое сообщение человеку. В КОНЦЕ ответа добавь строку [SEEN] <краткое текущее состояние в одну строку> — она не уйдёт человеку.`;
      } else if (kind === "browser_poll") {
        prompt = `[background wakeup] Проверь статус текущего браузер-джоба вызовом тула browser_task с task=${payload}. Если completed — отправь человеку результаты. Если ещё работает — ответь [SILENT] (wakeup сам повторится). Если failed — коротко скажи об этом.`;
      }
      await from(conversationId).send(prompt, {
        auth: {
          authenticator: "inkbox",
          issuer: "inkbox",
          principalType: "user",
          principalId: tenantPhone,
          // ponytail: wire v1 не терпит undefined в attributes — ключ опускаем
          attributes: inkboxHandle
            ? { conversationId, inkboxHandle }
            : { conversationId },
        },
      });
      return Response.json({ ok: true });
    }),
  ],
  events: {
    async "message.completed"(event, channel) {
      if (event.finishReason === "tool-calls" || !event.message) return;
      const conversationId = channel.continuation?.token;
      if (!conversationId) return;
      const { message, seen } = splitSeen(event.message);
      const tenant = await getTenantByConversation(conversationId).catch(() => null);
      if (seen !== undefined && tenant?.phoneE164) {
        await setWakeupLastSeen(tenant.phoneE164, seen).catch((err) => {
          console.error("setLastSeen failed", err);
        });
      }
      if (!message.trim() || message.trim().startsWith("[SILENT]")) return;
      const bubbles = toIMessageBubbles(stripConnectUrls(message));
      if (bubbles.length === 0) return;
      for (const text of bubbles) {
        await sendBlueIMessage({
          conversationId,
          text,
          handle: tenant?.inkboxHandle,
        });
      }
    },
  },
});
