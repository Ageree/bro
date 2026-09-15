/**
 * Single rule for "which eve conversation does this tenant's chat live in".
 *
 * Tenants onboarded through Photon (iMessage) carry `photonConversationId`
 * and no `inkboxConversationId` — Inkbox is mail-only now (see README).
 * Every background path that needs to reach the person's chat (browser
 * wakeups, reminder/watcher/brief wakeups, login-link/progress notes,
 * Telegram callbacks, the conversationId fallback in tool calls) must read
 * through this helper instead of `inkboxConversationId` alone, or Photon
 * tenants silently never get woken up.
 */
export function chatConversationId(
  t: { photonConversationId?: string; inkboxConversationId?: string } | null | undefined,
): string | undefined {
  const photon = t?.photonConversationId?.trim();
  if (photon) return photon;
  const inkbox = t?.inkboxConversationId?.trim();
  return inkbox || undefined;
}
