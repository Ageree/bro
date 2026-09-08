import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isValidHandle } from "./lib/accessPolicy";
import { newLoginCode, newSessionToken, sha256hex } from "./lib/cabinetPolicy";
import {
  formatEvent,
  parseComposioEvent,
  verifyComposioWebhook,
} from "./lib/watcherPolicy";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function bearer(request: Request): string {
  const raw = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)/i.exec(raw);
  return m?.[1] ?? "";
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const http = httpRouter();

http.route({
  path: "/access",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});

http.route({
  path: "/access",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await jsonBody(request);
    const handle =
      typeof body.handle === "string" && body.handle.length > 0
        ? body.handle
        : undefined;
    const ua = request.headers.get("user-agent") ?? "";
    const result = await ctx.runAction(internal.access.requestAccess, {
      handle,
      ua,
      create: true,
    });
    return json(result);
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
      const { confirmationUrl } = await ctx.runAction(
        internal.billing.createPaymentFor,
        { tenantId: tid },
      );
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

function options() {
  return httpAction(async () => new Response(null, { status: 204, headers: cors }));
}
http.route({ path: "/login/start", method: "OPTIONS", handler: options() });
http.route({ path: "/login/verify", method: "OPTIONS", handler: options() });
http.route({ path: "/logout", method: "OPTIONS", handler: options() });
http.route({ path: "/me", method: "OPTIONS", handler: options() });
http.route({ path: "/me/pay", method: "OPTIONS", handler: options() });
http.route({ path: "/me/browser-profile", method: "OPTIONS", handler: options() });
http.route({ path: "/me/browser-profile/refresh", method: "OPTIONS", handler: options() });
http.route({ path: "/me/memories/forget", method: "OPTIONS", handler: options() });
http.route({ path: "/me/tz", method: "OPTIONS", handler: options() });
http.route({ path: "/me/chatgpt/start", method: "OPTIONS", handler: options() });
http.route({ path: "/me/chatgpt/disconnect", method: "OPTIONS", handler: options() });
http.route({ path: "/me/computer", method: "OPTIONS", handler: options() });
http.route({ path: "/vault/items", method: "OPTIONS", handler: options() });
http.route({ path: "/vault/items/delete", method: "OPTIONS", handler: options() });

http.route({
  path: "/login/start",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await jsonBody(request);
    const handle = typeof body.handle === "string" ? body.handle.trim() : "";
    if (!isValidHandle(handle)) return json({ ok: false, code: "unavailable" });
    const code = newLoginCode();
    const begun = await ctx.runMutation(internal.cabinet.beginLogin, {
      handle,
      codeHash: await sha256hex(code),
      now: Date.now(),
    });
    if (!begun.ok) {
      return json({
        ok: false,
        code: begun.code === "cooldown" ? "cooldown" : "unavailable",
      });
    }
    try {
      await ctx.runAction(internal.cabinet.sendLoginCode, {
        identityId: begun.identityId,
        conversationId: begun.conversationId,
        code,
      });
    } catch (err) {
      console.error("login send", err);
      return json({ ok: false, code: "error" }, 500);
    }
    return json({ ok: true });
  }),
});

http.route({
  path: "/login/verify",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await jsonBody(request);
    const handle = typeof body.handle === "string" ? body.handle.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!isValidHandle(handle) || !/^\d{6}$/.test(code)) {
      return json({ ok: false, code: "unknown" });
    }
    const now = Date.now();
    const finished = await ctx.runMutation(internal.cabinet.finishLogin, {
      handle,
      codeHash: await sha256hex(code),
      now,
    });
    if (!finished.ok) return json(finished);
    const token = newSessionToken();
    await ctx.runMutation(internal.cabinet.issueSession, {
      tenantId: finished.tenantId,
      tokenHash: await sha256hex(token),
      now,
    });
    return json({ ok: true, token, handle });
  }),
});

http.route({
  path: "/logout",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (token) {
      await ctx.runMutation(internal.cabinet.revokeSession, {
        tokenHash: await sha256hex(token),
      });
    }
    return json({ ok: true });
  }),
});

http.route({
  path: "/me",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json({ ok: false, code: "unauthorized" }, 401);
    const now = Date.now();
    const session = await ctx.runQuery(internal.cabinet.getSessionTenant, {
      tokenHash: await sha256hex(token),
      now,
    });
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    const me = await ctx.runQuery(internal.cabinet.snapshotForTenant, {
      tenantId: session.tenantId,
      now,
    });
    if (!me) return json({ ok: false, code: "unauthorized" }, 401);
    return json({ ok: true, me });
  }),
});

http.route({
  path: "/me/browser-profile",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json({ ok: false, code: "unauthorized" }, 401);
    const session = await ctx.runQuery(internal.cabinet.getSessionTenant, {
      tokenHash: await sha256hex(token),
      now: Date.now(),
    });
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    const body = await jsonBody(request);
    const profileId = typeof body.profileId === "string" ? body.profileId : "";
    try {
      const refreshed = await ctx.runAction(internal.cabinet.refreshBrowserProfile, {
        tenantId: session.tenantId,
        profileId,
      });
      return json({ ok: true, ...refreshed });
    } catch (err) {
      console.error("me/browser-profile", err);
      return json({ ok: false, code: "invalid" }, 400);
    }
  }),
});

http.route({
  path: "/me/browser-profile/refresh",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json({ ok: false, code: "unauthorized" }, 401);
    const session = await ctx.runQuery(internal.cabinet.getSessionTenant, {
      tokenHash: await sha256hex(token),
      now: Date.now(),
    });
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    try {
      const refreshed = await ctx.runAction(internal.cabinet.refreshBrowserProfile, {
        tenantId: session.tenantId,
      });
      return json({ ok: true, ...refreshed });
    } catch (err) {
      console.error("me/browser-profile/refresh", err);
      return json({ ok: false, code: "error" }, 500);
    }
  }),
});

http.route({
  path: "/me/memories/forget",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json({ ok: false, code: "unauthorized" }, 401);
    const session = await ctx.runQuery(internal.cabinet.getSessionTenant, {
      tokenHash: await sha256hex(token),
      now: Date.now(),
    });
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    const body = await jsonBody(request);
    const needle = typeof body.needle === "string" ? body.needle : "";
    const forgotten = await ctx.runMutation(internal.cabinet.forgetMemoriesForTenant, {
      tenantId: session.tenantId,
      needle,
    });
    return json({ ok: true, forgotten });
  }),
});

http.route({
  path: "/me/tz",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json({ ok: false, code: "unauthorized" }, 401);
    const now = Date.now();
    const session = await ctx.runQuery(internal.cabinet.getSessionTenant, {
      tokenHash: await sha256hex(token),
      now,
    });
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    const body = await jsonBody(request);
    const tz = typeof body.tz === "string" ? body.tz : "";
    const result = await ctx.runMutation(internal.cabinet.setTzForSession, {
      tenantId: session.tenantId,
      tz,
      now,
    });
    if (!result.ok) return json({ ok: false, code: result.code }, 400);
    return json({ ok: true, tz: result.tz });
  }),
});

http.route({
  path: "/me/pay",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json({ ok: false, code: "unauthorized" }, 401);
    if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) {
      return json({ ok: false, code: "billing_off" }, 503);
    }
    const session = await ctx.runQuery(internal.cabinet.getSessionTenant, {
      tokenHash: await sha256hex(token),
      now: Date.now(),
    });
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    try {
      const { confirmationUrl } = await ctx.runAction(
        internal.billing.createPaymentFor,
        { tenantId: session.tenantId },
      );
      return json({ ok: true, confirmationUrl });
    } catch (err) {
      console.error("me/pay", err);
      return json({ ok: false, code: "error" }, 500);
    }
  }),
});

http.route({
  path: "/vault/items",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json({ ok: false, code: "unauthorized" }, 401);
    const session = await ctx.runQuery(internal.cabinet.getSessionTenant, {
      tokenHash: await sha256hex(token),
      now: Date.now(),
    });
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    const items = await ctx.runQuery(internal.vault.listItems, {
      tenantId: session.tenantId,
    });
    return json({ ok: true, items });
  }),
});

http.route({
  path: "/vault/items",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json({ ok: false, code: "unauthorized" }, 401);
    const session = await ctx.runQuery(internal.cabinet.getSessionTenant, {
      tokenHash: await sha256hex(token),
      now: Date.now(),
    });
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    const body = await jsonBody(request);
    const kind = body.kind;
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (
      (kind !== "login" &&
        kind !== "payment" &&
        kind !== "address" &&
        kind !== "contact") ||
      !label ||
      label.length > 120 ||
      typeof body.secret !== "string" ||
      body.secret.length > 20_000
    ) {
      return json({ ok: false, code: "invalid" }, 400);
    }
    try {
      const { handle } = await ctx.runAction(internal.vaultSecrets.save, {
        tenantId: session.tenantId,
        kind,
        label,
        secret: body.secret,
      });
      return json({ ok: true, handle });
    } catch (err) {
      console.error("vault save", err);
      return json({ ok: false, code: "invalid" }, 400);
    }
  }),
});

http.route({
  path: "/vault/items/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json({ ok: false, code: "unauthorized" }, 401);
    const session = await ctx.runQuery(internal.cabinet.getSessionTenant, {
      tokenHash: await sha256hex(token),
      now: Date.now(),
    });
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    const body = await jsonBody(request);
    const handle = typeof body.handle === "string" ? body.handle : "";
    const deleted = await ctx.runMutation(internal.vault.deleteItemByHandle, {
      tenantId: session.tenantId,
      handle,
    });
    return json({ ok: true, deleted });
  }),
});

http.route({
  path: "/composio",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.COMPOSIO_WEBHOOK_SECRET ?? "";
    if (!secret) return new Response("COMPOSIO_WEBHOOK_SECRET not set", { status: 500 });
    const body = await request.text();
    const h = (name: string) => request.headers.get(name) ?? "";
    const ok = await verifyComposioWebhook({
      id: h("webhook-id"),
      timestamp: h("webhook-timestamp"),
      signature: h("webhook-signature"),
      body,
      secret,
      nowMs: Date.now(),
    });
    if (!ok) return new Response("unauthorized", { status: 401 });
    const event = parseComposioEvent(body, h("webhook-id"));
    if (!event) return json({ ok: true, ignored: true });
    const outcome = await ctx.runMutation(internal.watchers.ingest, {
      eventId: event.eventId,
      triggerId: event.triggerId,
      userId: event.userId,
      text: formatEvent(event.triggerSlug, event.data),
      now: Date.now(),
    });
    console.log("composio webhook", event.triggerSlug, outcome);
    return json({ ok: true, outcome });
  }),
});

async function sessionTenant(
  ctx: {
    runQuery: (
      ref: typeof internal.cabinet.getSessionTenant,
      args: { tokenHash: string; now: number },
    ) => Promise<{ tenantId: Id<"tenants"> } | null>;
  },
  request: Request,
): Promise<{ tenantId: Id<"tenants"> } | null> {
  const token = bearer(request);
  if (!token) return null;
  return await ctx.runQuery(internal.cabinet.getSessionTenant, {
    tokenHash: await sha256hex(token),
    now: Date.now(),
  });
}

http.route({
  path: "/me/chatgpt/start",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const session = await sessionTenant(ctx, request);
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    try {
      const started = await ctx.runAction(
        (
          internal as unknown as {
            chatgptSecrets: {
              startDeviceLoginForTenant: typeof internal.cabinet.sendLoginCode;
            };
          }
        ).chatgptSecrets.startDeviceLoginForTenant as never,
        { tenantId: session.tenantId } as never,
      );
      return json({ ok: true, ...(started as object) });
    } catch (err) {
      console.error("me/chatgpt/start", err);
      return json({ ok: false, code: "unavailable" }, 503);
    }
  }),
});

http.route({
  path: "/me/chatgpt/disconnect",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const session = await sessionTenant(ctx, request);
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    const phone = await ctx.runQuery(internal.cabinet.sessionPhone, {
      tenantId: session.tenantId,
    });
    if (!phone) return json({ ok: false, code: "unbound" }, 400);
    try {
      await ctx.runAction(
        (
          internal as unknown as {
            chatgptSecrets: { disconnectForTenant: never };
          }
        ).chatgptSecrets.disconnectForTenant as never,
        { tenantId: session.tenantId } as never,
      );
      return json({ ok: true });
    } catch (err) {
      console.error("me/chatgpt/disconnect", err);
      return json({ ok: false, code: "unavailable" }, 503);
    }
  }),
});

http.route({
  path: "/me/computer",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const session = await sessionTenant(ctx, request);
    if (!session) return json({ ok: false, code: "unauthorized" }, 401);
    const phone = await ctx.runQuery(internal.cabinet.sessionPhone, {
      tenantId: session.tenantId,
    });
    if (!phone) return json({ ok: false, code: "unbound" }, 400);
    const body = await jsonBody(request);
    const action =
      body.action === "wake" || body.action === "stop" || body.action === "wipe"
        ? body.action
        : "";
    if (!action) return json({ ok: false, code: "invalid" }, 400);
    const eveUrl = process.env.EVE_URL;
    const secret = process.env.BRO_INTERNAL_SECRET ?? "";
    if (!eveUrl) return json({ ok: false, code: "unavailable" }, 503);
    try {
      const res = await fetch(`${eveUrl.replace(/\/$/, "")}/internal/computer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret,
          phoneE164: phone.phoneE164,
          action,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        state?: string;
        error?: string;
      };
      if (!res.ok || payload.ok === false) {
        return json(
          { ok: false, code: "computer_failed", error: payload.error },
          res.status === 401 ? 401 : 503,
        );
      }
      return json({ ok: true, state: payload.state ?? "ok" });
    } catch (err) {
      console.error("me/computer", err);
      return json({ ok: false, code: "unavailable" }, 503);
    }
  }),
});

export default http;
