import { hasConversationHistory } from "@db/services/chats";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Handed to the model with the first message this workspace ever sent, in any
 * channel. The instructions look for the `first-contact` marker and introduce
 * Bro once, in Russian.
 */
const firstContactMarker =
  "Пометка `first-contact`: аккаунт этого человека создан прямо сейчас, это его первое в жизни сообщение, и знакомства ещё не было.";

/**
 * The turn context that opens a person's very first conversation, or nothing.
 * It depends on the workspace rather than on the session or the account: a new
 * web chat, a freshly linked Telegram and an account made by the sign-in form
 * are all first contact only while nobody in the workspace has written yet.
 * Channels call this before the turn starts, which is before the message is
 * recorded as a chat.
 */
export async function firstContactContext(scope: AccessScope) {
  return (await hasConversationHistory(scope)) ? [] : [firstContactMarker];
}
