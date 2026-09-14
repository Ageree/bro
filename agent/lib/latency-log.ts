/**
 * Where does the time go between the webhook and the first bubble? Channels
 * stamp the receipt time on the turn's auth attributes (they travel with the
 * session into whatever process runs the turn — in-memory maps do not), and
 * every later log line reports `sinceInboundMs`. Read it in Vercel logs.
 */

export const INBOUND_AT_ATTR = "inboundAt";

export function inboundAtAttribute(now = Date.now()): Record<string, string> {
  return { [INBOUND_AT_ATTR]: String(now) };
}

export function inboundAt(
  attrs: Readonly<Record<string, unknown>> | null | undefined,
): number | undefined {
  const raw = attrs?.[INBOUND_AT_ATTR];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Milliseconds since the channel received the human's message, if stamped. */
export function sinceInbound(
  attrs: Readonly<Record<string, unknown>> | null | undefined,
  now = Date.now(),
): number | undefined {
  const at = inboundAt(attrs);
  return at === undefined ? undefined : Math.max(0, now - at);
}

/** `{ sinceInboundMs }` for spreading into a structured log line. */
export function latencyFields(
  attrs: Readonly<Record<string, unknown>> | null | undefined,
  now = Date.now(),
): { sinceInboundMs?: number } {
  const ms = sinceInbound(attrs, now);
  return ms === undefined ? {} : { sinceInboundMs: ms };
}
