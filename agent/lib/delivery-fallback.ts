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

/**
 * What a person hears when the model provider refused the turn: out of
 * credits, rate limited, down. The reason is the owner's problem, so none of
 * it reaches the chat.
 */
const modelOutageText = "я прилёг, скоро вернусь";

/**
 * The line a messaging channel posts for a failed turn, or nothing when the
 * failure was not the model provider's. eve reports every failed model call,
 * whatever the provider answered, as `MODEL_CALL_FAILED`.
 */
export function modelOutageNotice(failure: { readonly code: string }) {
  return failure.code === "MODEL_CALL_FAILED" ? modelOutageText : undefined;
}
