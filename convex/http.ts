import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

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

export default http;
