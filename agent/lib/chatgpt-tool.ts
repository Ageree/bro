import { ConvexHttpClient } from "convex/browser";
import type { ToolContext } from "eve/tools";
import { groupPersonalBlock } from "./group-guard";
import { tenantId } from "./tenant";

const SHARED = new Set(["local-dev", "unknown", "default", "eve:app"]);

/**
 * Shared guard + Convex-HTTP-client call for the chatgpt_* agent tools:
 * refuse group turns, refuse SHARED principals, no-op when env is missing,
 * and swallow/log any call failure — each with the caller's own fallbacks.
 */
export async function chatgptAgentCall<T>(opts: {
  ctx: ToolContext;
  sharedFallback: T;
  envFallback: T;
  errorLabel: string;
  catchFallback: (err: unknown) => T;
  call: (client: ConvexHttpClient, secret: string, phoneE164: string) => Promise<T>;
}): Promise<T | { status: "group"; error: string }> {
  const blocked = groupPersonalBlock(opts.ctx);
  if (blocked) return { status: "group", error: blocked };
  const phone = tenantId(opts.ctx);
  if (SHARED.has(phone)) return opts.sharedFallback;

  const url = process.env.CONVEX_URL?.trim();
  const secret = process.env.BRO_INTERNAL_SECRET?.trim();
  if (!url || !secret) return opts.envFallback;

  try {
    const client = new ConvexHttpClient(url);
    return await opts.call(client, secret, phone);
  } catch (err) {
    console.error(opts.errorLabel, err);
    return opts.catchFallback(err);
  }
}
