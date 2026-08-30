import { v } from "convex/values";
import { action } from "./_generated/server";
import { exolveMakeCallbackBody, normalizeE164 } from "./lib/callPolicy";
import { assertSecret } from "./secret";

const EXOLVE_MAKE = "https://api.exolve.ru/call/v1/MakeCallback";

export const startCallback = action({
  args: {
    secret: v.string(),
    destE164: v.string(),
    inkboxE164: v.string(),
    requestId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ callId: v.string() }),
    v.object({ error: v.string() }),
  ),
  handler: async (_ctx, args) => {
    assertSecret(args.secret);
    const key = (process.env.EXOLVE_API_KEY ?? "").trim();
    const number = normalizeE164(process.env.EXOLVE_NUMBER ?? "");
    const resourceId = Number(
      (process.env.EXOLVE_CALLBACK_RESOURCE_ID ?? "").trim(),
    );
    if (!key || !number || !Number.isInteger(resourceId) || resourceId <= 0) {
      return { error: "Exolve env missing on Convex" };
    }
    const dest = normalizeE164(args.destE164);
    const inkbox = normalizeE164(args.inkboxE164);
    if (!dest || !inkbox) return { error: "bad dest or inkbox number" };
    const body = exolveMakeCallbackBody({
      numberE164: number,
      resourceId,
      inkboxE164: inkbox,
      destE164: dest,
      requestId: args.requestId,
    });
    const res = await fetch(EXOLVE_MAKE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: { call_id?: unknown; message?: unknown; error?: unknown } = {};
    try {
      json = text ? (JSON.parse(text) as typeof json) : {};
    } catch {
      json = { message: text.slice(0, 300) };
    }
    if (!res.ok || typeof json.call_id !== "string" || !json.call_id) {
      const detail = json.message ?? json.error ?? text.slice(0, 300);
      return {
        error: `exolve MakeCallback ${res.status}: ${
          typeof detail === "string" ? detail : JSON.stringify(detail)
        }`,
      };
    }
    return { callId: json.call_id };
  },
});
