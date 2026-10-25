import { env } from "@shared/environment";

/**
 * Whether a side of Bro ↔ Bro is the second version's
 * (`BRO_TO_BRO_V2_WORKSPACES`, docs/bro-to-bro.md, «Вторая версия»): its
 * envoy, its gate, its owner's tools and the delivery of its reports. Each
 * side by its own workspace, so a thread between the two versions runs
 * each side by its own.
 */
export function broToBroV2(workspaceId: string) {
  return (env.BRO_TO_BRO_V2_WORKSPACES ?? []).some(
    (entry) => entry === "*" || entry === workspaceId
  );
}
