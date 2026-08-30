import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  twilioCallerId,
  twilioDialTwiml,
  twilioHangupTwiml,
  twilioSignaturePayload,
  zadarmaBridgeReply,
  zadarmaNotifyPayload,
} from "./lib/callPolicy";
import { timingSafeEqual } from "./secret";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const http = httpRouter();

http.route({
  path: "/access",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: cors });
  }),
});

http.route({
  path: "/access",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let handle: string | undefined;
    try {
      const body = (await request.json()) as { handle?: unknown };
      if (typeof body.handle === "string" && body.handle.length > 0) {
        handle = body.handle;
      }
    } catch {
      handle = undefined;
    }
    const ua = request.headers.get("user-agent") ?? "";
    const result = await ctx.runAction(internal.access.requestAccess, {
      handle,
      ua,
      create: true,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/yookassa",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let paymentId: string | undefined;
    try {
      const body = (await request.json()) as { object?: { id?: unknown } };
      if (typeof body.object?.id === "string") paymentId = body.object.id;
    } catch {
      paymentId = undefined;
    }
    if (paymentId) {
      try {
        await ctx.runAction(internal.billing.verifyAndApply, { paymentId });
      } catch (err) {
        console.error("yookassa webhook", err);
      }
    }
    return new Response(null, { status: 200 });
  }),
});

http.route({
  path: "/pay",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let tid = "";
    try {
      tid = new URL(request.url).searchParams.get("tid") ?? "";
    } catch {
      tid = "";
    }
    if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) {
      return new Response("оплата скоро", { status: 503 });
    }
    if (!tid) return new Response("нет tid", { status: 400 });
    try {
      const { confirmationUrl } = await ctx.runAction(internal.billing.createPaymentFor, {
        tenantId: tid,
      });
      return new Response(null, {
        status: 302,
        headers: { Location: confirmationUrl },
      });
    } catch (err) {
      console.error("pay", err);
      return new Response("не получилось", { status: 500 });
    }
  }),
});

http.route({
  path: "/call-bridge",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let secret = "";
    let from = "";
    try {
      const u = new URL(request.url);
      secret = u.searchParams.get("secret") ?? "";
      from = u.searchParams.get("from") ?? "";
    } catch {
      return new Response("bad url", { status: 400 });
    }
    const expected = process.env.BRO_INTERNAL_SECRET ?? "";
    if (!expected || !timingSafeEqual(secret, expected)) {
      return new Response("unauthorized", { status: 401 });
    }
    const hit = await ctx.runMutation(internal.calls.claimForBridge, {
      fromE164: from || undefined,
    });
    if (!hit) {
      return new Response(JSON.stringify({ error: "no pending" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(hit), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/zadarma-bridge",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    try {
      const echo = new URL(request.url).searchParams.get("zd_echo");
      if (echo !== null) return new Response(echo, { status: 200 });
    } catch {
      /* ignore */
    }
    return new Response("ok", { status: 200 });
  }),
});

http.route({
  path: "/zadarma-bridge",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let echo: string | null = null;
    try {
      echo = new URL(request.url).searchParams.get("zd_echo");
    } catch {
      echo = null;
    }
    if (echo !== null) return new Response(echo, { status: 200 });

    const fields = await readZadarmaFields(request);
    if (fields.zdEcho !== null) return new Response(fields.zdEcho, { status: 200 });

    const secret = process.env.ZADARMA_API_SECRET ?? "";
    if (!secret) return new Response("zadarma not configured", { status: 503 });

    const sig =
      request.headers.get("Signature") ?? request.headers.get("signature") ?? "";
    const expected = await hmacSha1Base64(
      secret,
      zadarmaNotifyPayload(fields.callerId, fields.calledDid, fields.callStart),
    );
    if (!timingSafeEqual(sig, expected)) {
      return new Response("unauthorized", { status: 401 });
    }

    if (fields.event && fields.event !== "NOTIFY_START") {
      return jsonReply({});
    }

    const hit = await ctx.runMutation(internal.calls.claimForBridge, {
      fromE164: fields.callerId || undefined,
    });
    const ext = (process.env.ZADARMA_PBX_EXTENSION ?? "100").trim() || "100";
    return jsonReply(zadarmaBridgeReply(hit?.destE164 ?? null, ext));
  }),
});

http.route({
  path: "/twilio-voice",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(twilioHangupTwiml(), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }),
});

http.route({
  path: "/twilio-voice",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = (process.env.TWILIO_AUTH_TOKEN ?? "").trim();
    const expected = process.env.BRO_INTERNAL_SECRET ?? "";
    let secret = "";
    let url = request.url;
    try {
      const parsed = new URL(request.url);
      secret = parsed.searchParams.get("secret") ?? "";
      url = parsed.toString();
    } catch {
      return new Response("bad url", { status: 400 });
    }
    const form = await readFormParams(request);
    const secretOk = Boolean(expected) && timingSafeEqual(secret, expected);
    if (token) {
      const sig =
        request.headers.get("X-Twilio-Signature") ??
        request.headers.get("x-twilio-signature") ??
        "";
      const payload = twilioSignaturePayload(url, form);
      const good = await hmacSha1Base64(token, payload);
      const sigOk = Boolean(sig) && timingSafeEqual(sig, good);
      if (!sigOk && !secretOk) {
        return new Response("unauthorized", { status: 401 });
      }
    } else if (!secretOk) {
      return new Response("unauthorized", { status: 401 });
    }
    const from = form.From ?? form.from ?? "";
    const hit = await ctx.runMutation(internal.calls.claimForBridge, {
      fromE164: from || undefined,
    });
    const xml = hit?.destE164
      ? twilioDialTwiml({
          destE164: hit.destE164,
          callerId: twilioCallerId(process.env),
        })
      : twilioHangupTwiml();
    return new Response(xml, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }),
});

export default http;

function jsonReply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function hmacSha1Base64(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  const bytes = new Uint8Array(mac);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function readZadarmaFields(request: Request): Promise<{
  event: string;
  callerId: string;
  calledDid: string;
  callStart: string;
  zdEcho: string | null;
}> {
  const empty = {
    event: "",
    callerId: "",
    calledDid: "",
    callStart: "",
    zdEcho: null as string | null,
  };
  const ctype = request.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("application/json")) {
      const rec = (await request.json()) as Record<string, unknown>;
      return {
        event: strField(rec.event),
        callerId: strField(rec.caller_id),
        calledDid: strField(rec.called_did),
        callStart: strField(rec.call_start),
        zdEcho: rec.zd_echo == null ? null : strField(rec.zd_echo),
      };
    }
    const form = await request.formData();
    const echo = form.get("zd_echo");
    return {
      event: formStr(form, "event"),
      callerId: formStr(form, "caller_id"),
      calledDid: formStr(form, "called_did"),
      callStart: formStr(form, "call_start"),
      zdEcho: typeof echo === "string" ? echo : null,
    };
  } catch {
    return empty;
  }
}

function strField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formStr(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

async function readFormParams(request: Request): Promise<Record<string, string>> {
  const ctype = request.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  try {
    if (ctype.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(await request.text());
      for (const [k, v] of params) out[k] = v;
      return out;
    }
    if (ctype.includes("application/json")) {
      const rec = (await request.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(rec)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
    const form = await request.formData();
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") out[k] = v;
    }
  } catch {
    /* empty */
  }
  return out;
}
