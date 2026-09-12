import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { clipOpsDetail, type OpsEventKind } from "./opsPolicy";

export async function insertOpsEvent(
  ctx: MutationCtx,
  args: {
    kind: OpsEventKind;
    at: number;
    tenantId?: Id<"tenants">;
    detail?: string;
  },
): Promise<void> {
  const detail = clipOpsDetail(args.detail);
  await ctx.db.insert("opsEvents", {
    kind: args.kind,
    at: args.at,
    ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    ...(detail ? { detail } : {}),
  });
}
