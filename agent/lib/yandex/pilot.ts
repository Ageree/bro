import { env } from "@shared/environment";

/**
 * Whether the workspace is in the pilot of the Yandex tool
 * (YANDEX_API_WORKSPACES): named by its id, or everyone with `*`. Unset,
 * nobody is. The list takes no emails, so nothing is looked up.
 */
export function yandexPilot(scope: { readonly workspaceId: string }) {
  const list = env.YANDEX_API_WORKSPACES ?? [];
  return list.includes("*") || list.includes(scope.workspaceId);
}

export function yandexPurchasePilot(scope: { readonly workspaceId: string }) {
  const list = env.YANDEX_PURCHASE_WORKSPACES ?? [];
  return (
    yandexPilot(scope) &&
    (list.includes("*") || list.includes(scope.workspaceId))
  );
}
