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

export default http;
