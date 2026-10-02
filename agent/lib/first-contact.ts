import { firstContactMarker } from "@agent/lib/delivery/first-contact";
import { claimWorkspaceIntroduction } from "@db/services/scope";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * The turn context that opens a person's very first conversation, or nothing.
 * It depends on the workspace rather than on the session or the account: a new
 * web chat, a freshly linked Telegram and an account made by the sign-in form
 * are all first contact only until the workspace has been introduced once.
 * Claiming the introduction is atomic, so a channel calls this only for a
 * message that is about to start a turn.
 */
export async function firstContactContext(scope: AccessScope) {
  return (await claimWorkspaceIntroduction(scope)) ? [firstContactMarker] : [];
}
