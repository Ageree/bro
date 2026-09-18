import { sql } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, usageCounters } from "@db";
import { ensureScope } from "./scope";

export type UsageCounterKind = (typeof usageCounters.$inferSelect)["kind"];

/**
 * Counts one metered action and returns the running total including it, in a
 * single statement. Two messages that arrive together on different instances
 * therefore get 30 and 31 rather than both reading 29 and both being let
 * through.
 */
export async function countUsage(
  scope: AccessScope,
  kind: UsageCounterKind,
  periodKey: string
) {
  await ensureScope(scope);
  const [row] = await db
    .insert(usageCounters)
    .values({
      count: 1,
      kind,
      periodKey,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [
        usageCounters.workspaceId,
        usageCounters.kind,
        usageCounters.periodKey,
      ],
      set: {
        count: sql`${usageCounters.count} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ count: usageCounters.count });
  if (!row) throw new Error("The usage counter could not be updated.");
  return row.count;
}
