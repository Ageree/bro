import type { DynamicResolveContext } from "eve";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { cardsEnabled } from "@shared/cards/pilot";

/**
 * Whether the conversation can be sent cards: a person's Telegram chat of a
 * workspace in the pilot. The cards' instructions and tools all ask it.
 */
export function cardsOffered(context: DynamicResolveContext) {
  const auth = context.session.auth.current;
  return (
    context.channel.kind === "channel:telegram" &&
    resolveModeValue(context, { interactive: true }) === true &&
    auth?.principalType === "user" &&
    cardsEnabled(scopeFromPrincipal(auth))
  );
}
