/** Returning 1:1 users already have phone + conversation on the handle tenant. */

export function canSkipInboundBind(
  tenant:
    | {
        phoneE164?: string | null;
        inkboxConversationId?: string | null;
        status?: string | null;
      }
    | null
    | undefined,
  phoneE164: string,
  conversationId?: string,
): boolean {
  if (!tenant || tenant.status === "disabled") return false;
  if (!tenant.phoneE164 || tenant.phoneE164 !== phoneE164) return false;
  const conversation = conversationId?.trim();
  if (!conversation) return true;
  return tenant.inkboxConversationId === conversation;
}
