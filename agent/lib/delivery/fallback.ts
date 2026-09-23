/**
 * Sentinel the interactive and scheduled-report instructions ask the model to
 * write once `send_message` already delivered the reply. It is bookkeeping for
 * the runtime, never something a person should read.
 */
const deliveryCompleteSentinel = "DELIVERY_COMPLETE";

/**
 * Assistant text a channel should deliver itself because the model answered in
 * plain text instead of calling `send_message`. Returns nothing when the model
 * wrote no text or only the sentinel that marks an already delivered reply. A
 * sentinel the model appended to real text is dropped rather than shown.
 */
export function fallbackDeliveryText(message: string | null | undefined) {
  const text = message?.replaceAll(deliveryCompleteSentinel, "").trim();
  if (!text) return undefined;
  return text;
}
