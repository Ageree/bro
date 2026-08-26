import { defineChannel, POST } from "eve/channels";
import type { IMessageWebhookPayload } from "@inkbox/sdk";
import {
  agentHandle,
  allowlisted,
  inkbox,
  isBlueIMessage,
  sendBlueIMessage,
  webhookOk,
} from "../lib/inkbox";
import { upsertTenant } from "../lib/convex";

export default defineChannel({
  turnPolicy: "steer",
  routes: [
    POST("/webhooks/imessage", async (request, { from, waitUntil }) => {
      const secret = process.env.INKBOX_WEBHOOK_SECRET;
      if (!secret) return new Response("missing INKBOX_WEBHOOK_SECRET", { status: 500 });

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
      if (!allowlisted(remote)) {
        return new Response(null, { status: 204 });
      }

      const text = msg.content?.trim();
      if (!text) return new Response(null, { status: 204 });

      if (remote) {
        try {
          await upsertTenant(remote, msg.conversation_id);
        } catch (err) {
          console.error("tenant upsert failed", err);
        }
      }

      const ack = (async () => {
        try {
          const identity = await inkbox().getIdentity(agentHandle());
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
          principalId: remote ?? "unknown",
          attributes: { conversationId: msg.conversation_id },
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
      await sendBlueIMessage({ conversationId, text: event.message });
    },
  },
});
