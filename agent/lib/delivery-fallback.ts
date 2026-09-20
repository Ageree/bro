/**
 * Sentinel the interactive and scheduled-report instructions ask the model to
 * write once `send_message` already delivered the reply. It is bookkeeping for
 * the runtime, never something a person should read.
 */
const deliveryCompleteSentinel = "DELIVERY_COMPLETE";

/**
 * Assistant text a channel should deliver itself because the model answered in
 * plain text instead of calling `send_message`. Returns nothing when the model
 * wrote no text or only the sentinel that marks an already delivered reply.
 */
export function fallbackDeliveryText(message: string | null | undefined) {
  const text = message?.trim();
  if (!text || text === deliveryCompleteSentinel) return undefined;
  return text;
}
