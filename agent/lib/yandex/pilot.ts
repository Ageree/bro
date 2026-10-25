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

/**
 * Whether the workspace buys Afisha tickets through the widget's API
 * (YANDEX_AFISHA_PURCHASE_WORKSPACES), within the purchase pilot.
 */
export function afishaPurchasePilot(scope: { readonly workspaceId: string }) {
  const list = env.YANDEX_AFISHA_PURCHASE_WORKSPACES ?? [];
  return (
    yandexPurchasePilot(scope) &&
    (list.includes("*") || list.includes(scope.workspaceId))
  );
}

/**
 * Whether the workspace books Go rides for someone else, within the purchase
 * pilot: YANDEX_GO_PASSENGER_WORKSPACES unset, empty or `*` is everyone (the
 * owner, 23.10), `off` nobody, a list of workspace ids only them.
 */
export function goPassengerPilot(scope: { readonly workspaceId: string }) {
  const list = env.YANDEX_GO_PASSENGER_WORKSPACES ?? [];
  if (!yandexPurchasePilot(scope) || list.includes("off")) return false;
  return (
    list.length === 0 || list.includes("*") || list.includes(scope.workspaceId)
  );
}

/**
 * Whether the person's own Go ride goes as their Go app books it, within the
 * purchase pilot (YANDEX_GO_OWN_RIDE_WORKSPACES): named by its id, or
 * everyone with `*`. Unset, nobody.
 */
export function goOwnRidePilot(scope: { readonly workspaceId: string }) {
  const list = env.YANDEX_GO_OWN_RIDE_WORKSPACES ?? [];
  return (
    yandexPurchasePilot(scope) &&
    (list.includes("*") || list.includes(scope.workspaceId))
  );
}

/**
 * Whether Bro follows the Go rides it books and tells the person in the chat
 * when a car is found, when to step out and when it is there, within the
 * purchase pilot (YANDEX_GO_WATCH_WORKSPACES): named by its id, or everyone
 * with `*`. Unset, nobody.
 */
export function goWatchPilot(scope: { readonly workspaceId: string }) {
  const list = env.YANDEX_GO_WATCH_WORKSPACES ?? [];
  return (
    yandexPurchasePilot(scope) &&
    (list.includes("*") || list.includes(scope.workspaceId))
  );
}

/** Whether the workspace's public reads may skip the browser (YANDEX_DIRECT_WORKSPACES). */
export function yandexDirectPilot(scope: { readonly workspaceId: string }) {
  const list = env.YANDEX_DIRECT_WORKSPACES ?? [];
  return (
    yandexPilot(scope) &&
    (list.includes("*") || list.includes(scope.workspaceId))
  );
}
