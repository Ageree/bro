import { createHmac, timingSafeEqual } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import { localDev, routeAuth, vercelOidc } from "eve/channels/auth";
import { z } from "zod";
import {
  deliverEveBrowserRun,
  settleBrowserRun,
} from "@agent/lib/browser-use/completion";
import { readBrowserRun } from "@db/services/browser-runs";
import { env } from "@shared/environment";

/**
 * Browser Use signs `{timestamp}.{canonical payload}`, where the canonical
 * payload is the parsed event re-serialized with sorted keys, compact
 * separators and non-ASCII escaped — not the raw request body. The five-minute
 * window bounds replay; the delivered outcome is made idempotent downstream.
 */
const signatureSkewSeconds = 300;
const internalRouteAuth = [vercelOidc(), localDev()];

export const browserDeliverySchema = z.strictObject({
  lineageRevision: z.int().nonnegative(),
  rootRunId: z.uuid(),
});
export type BrowserDeliveryRequest = z.infer<typeof browserDeliverySchema>;

const webhookEventSchema = z.object({
  payload: z.looseObject({
    run_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    status: z.string().optional(),
    task_id: z.string().min(1).optional(),
  }),
  timestamp: z.string().optional(),
  type: z.string(),
});

const terminalStatuses = new Set([
  "cancelled",
  "completed",
  "failed",
  "finished",
  "idle",
  "stopped",
]);

const jsonObjectSchema = z.record(z.string(), z.json());

type WebhookJson = z.infer<ReturnType<typeof z.json>>;

/**
 * Python's `json.dumps(payload, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=True)` over the parsed event — the exact bytes Browser Use
 * signs, which are not the raw request body.
 */
export function canonicalWebhookPayload(value: WebhookJson): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalWebhookPayload).join(",")}]`;
  }
  const object = jsonObjectSchema.safeParse(value);
  if (!object.success) return escapeNonAscii(JSON.stringify(value));
  const entries = Object.entries(object.data).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return `{${entries
    .map(
      ([key, item]) =>
        `${escapeNonAscii(JSON.stringify(key))}:${canonicalWebhookPayload(item)}`
    )
    .join(",")}}`;
}

// `ensure_ascii` escapes every code point above ASCII, and an astral character
// as the surrogate pair JavaScript already stores it as.
function escapeNonAscii(value: string) {
  return value.replaceAll(/[^\u0020-\u007F]/gu, (character) => {
    let escaped = "";
    for (const unit of codeUnits(character)) {
      escaped += `\\u${unit.toString(16).padStart(4, "0")}`;
    }
    return escaped;
  });
}

function codeUnits(character: string) {
  const units: number[] = [];
  for (let index = 0; index < character.length; index += 1) {
    units.push(character.charCodeAt(index));
  }
  return units;
}

export function browserUseSignatureValid(options: {
  readonly body: string;
  readonly now: Date;
  readonly secret: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
}) {
  const { body, now, secret, signature, timestamp } = options;
  if (!timestamp || !/^\d{1,12}$/u.test(timestamp)) return false;
  if (!signature || !/^[0-9a-f]{64}$/u.test(signature)) return false;
  const skew = Math.abs(Math.floor(now.getTime() / 1_000) - Number(timestamp));
  if (skew > signatureSkewSeconds) return false;

  const parsed = jsonObject(body);
  if (!parsed) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${canonicalWebhookPayload(parsed)}`, "utf8")
    .digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function jsonObject(body: string) {
  try {
    return jsonObjectSchema.parse(JSON.parse(body));
  } catch {
    return undefined;
  }
}

export default defineChannel({
  audience() {
    return "unknown";
  },
  receive() {
    throw new Error("The Browser Use channel only accepts webhook deliveries.");
  },
  routes: [
    POST(
      "/internal/browser-use/delivery",
      async (request, { attachSession }) => {
        const auth = await routeAuth(request, internalRouteAuth);
        if (auth instanceof Response) return auth;
        const input = browserDeliverySchema.parse(await request.json());
        const status = await deliverEveBrowserRun(attachSession, input);
        return new Response(null, {
          status: status === "accepted" ? 202 : 409,
        });
      }
    ),
    POST(
      "/webhooks/browser-use",
      async (request, { attachSession, to, waitUntil }) => {
        const secret = env.BROWSER_USE_WEBHOOK_SECRET;
        if (!secret) return new Response(null, { status: 401 });
        const body = await request.text();
        if (
          !browserUseSignatureValid({
            body,
            now: new Date(),
            secret,
            signature: request.headers.get("x-browser-use-signature"),
            timestamp: request.headers.get("x-browser-use-timestamp"),
          })
        ) {
          return new Response(null, { status: 401 });
        }

        const event = webhookEventSchema.safeParse(jsonObject(body));
        if (!event.success) return new Response(null, { status: 200 });
        const { payload } = event.data;
        const status = payload.status?.toLowerCase();
        if (status !== undefined && !terminalStatuses.has(status)) {
          return new Response(null, { status: 200 });
        }
        const runId = payload.run_id ?? payload.task_id ?? payload.session_id;
        if (!runId) return new Response(null, { status: 200 });
        // An id this deployment never started is someone else's run, or a
        // dashboard test ping. Nothing to settle, and nothing to report.
        if (!(await readBrowserRun(runId))) {
          return new Response(null, { status: 200 });
        }
        waitUntil(settleBrowserRun({ attachSession, to }, runId));
        return new Response(null, { status: 200 });
      }
    ),
  ],
});
