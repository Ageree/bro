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
  getTenantByConversation,
  getTenantByHandle,
  upsertTenant,
} from "../lib/convex";
import {
  connectCardHtml,
  isConnectDest,
  stripConnectUrls,
} from "../lib/connect-link";

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

      const text = msg.content?.trim();
      if (!text) return new Response(null, { status: 204 });
      console.log("imessage inbound", {
        remote,
        conversationId: msg.conversation_id,
        chars: text.length,
      });

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
  ],
  events: {
    async "message.completed"(event, channel) {
      if (event.finishReason === "tool-calls" || !event.message) return;
      const conversationId = channel.continuation?.token;
      if (!conversationId) return;
      const tenant = await getTenantByConversation(conversationId).catch(() => null);
      const text = stripConnectUrls(event.message);
      if (!text) return;
      await sendBlueIMessage({
        conversationId,
        text,
        handle: tenant?.inkboxHandle,
      });
    },
  },
});
