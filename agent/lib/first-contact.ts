import { bugBotTarget } from "@agent/lib/bug-bot/target";
import { claimWorkspaceIntroduction } from "@db/services/scope";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Handed to the model with the first message this workspace ever sent, in any
 * channel. The instructions look for the `first-contact` marker and introduce
 * Bro once, in the language the person wrote in.
 */
const firstContactMarker =
  "Пометка `first-contact`: аккаунт этого человека создан прямо сейчас, это его первое в жизни сообщение, и знакомства ещё не было.";

/**
 * The beta and where faults go, only while the bug bot is on
 * (`bugBotTarget`) and BUG_BOT_USERNAME names it, as Telegram's `/bug` hint:
 * the model never invents a handle, and without the bot nobody reads a fault.
 * The introduction names no terms, privacy or data rules (owner, 12.10).
 */
function betaNote() {
  const bot = env.BUG_BOT_USERNAME;
  return bot === undefined || bugBotTarget() === undefined
    ? []
    : [
        `Для знакомства: Бро сейчас в бете. О сбоях и идеях — в Telegram @${bot}.`,
      ];
}

/**
 * The turn context that opens a person's very first conversation, or nothing.
 * It depends on the workspace rather than on the session or the account: a new
 * web chat, a freshly linked Telegram and an account made by the sign-in form
 * are all first contact only until the workspace has been introduced once.
 * Claiming the introduction is atomic, so a channel calls this only for a
 * message that is about to start a turn.
 */
export async function firstContactContext(scope: AccessScope) {
  return (await claimWorkspaceIntroduction(scope))
    ? [firstContactMarker, ...betaNote()]
    : [];
}
