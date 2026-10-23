import type { DynamicResolveContext } from "eve";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { env } from "@shared/environment";

/**
 * Whether cards are on for the workspace (`CARDS_WORKSPACES`): named by its
 * id, or everyone with `*`. Unset, nobody is.
 */
export function cardsEnabled(scope: { readonly workspaceId: string }) {
  const list = env.CARDS_WORKSPACES ?? [];
  return list.includes("*") || list.includes(scope.workspaceId);
}

/**
 * Whether the conversation can be sent cards: a person's Telegram chat of a
 * workspace in the pilot. The cards' instructions and tool both ask it.
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
