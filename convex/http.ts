import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { cardPlain, encryptCard, isCardKey, parseCardInput } from "./lib/cardPolicy";

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
  path: "/card",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: cors });
  }),
});

http.route({
  path: "/card",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const key = process.env.BRO_CARD_KEY ?? "";
    if (!isCardKey(key)) {
      return new Response(JSON.stringify({ ok: false, error: "misconfigured" }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    let body: { token?: unknown; pan?: unknown; expMonth?: unknown; expYear?: unknown; cvc?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "bad json" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const parsed = parseCardInput({
      pan: String(body.pan ?? ""),
      expMonth: Number(body.expMonth),
      expYear: Number(body.expYear),
      cvc: String(body.cvc ?? ""),
    });
    if (!parsed.ok) {
      return new Response(JSON.stringify({ ok: false, error: parsed.error }), {
        status: 422,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    let blob: string;
    try {
      blob = await encryptCard(cardPlain(parsed.pan, parsed.cvc), key);
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "misconfigured" }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    try {
      const saved = await ctx.runMutation(internal.cards.consumeLink, {
        token: String(body.token ?? ""),
        last4: parsed.last4,
        brand: parsed.brand,
        expMonth: parsed.expMonth,
        expYear: parsed.expYear,
        blob,
      });
      return new Response(JSON.stringify({ ok: true, ...saved }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid or expired link" }), {
        status: 422,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }),
});

export default http;
