import { env } from "@shared/environment";

/**
 * Whether cards are on for the workspace (`CARDS_WORKSPACES`): named by its
 * id, or everyone with `*`. Unset, nobody is. Bro asks it before sending a
 * card, and the card's page before it takes an answer.
 */
export function cardsEnabled(scope: { readonly workspaceId: string }) {
  const list = env.CARDS_WORKSPACES ?? [];
  return list.includes("*") || list.includes(scope.workspaceId);
}
