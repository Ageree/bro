import { and, eq } from "drizzle-orm";
import { db, settings } from "@db";

const agencyPausedKey = "agency_paused";

/**
 * Whether the person stopped Bro's own work in this workspace («стоп»). The
 * dispatcher reads it before it starts a run.
 */
export async function isAgencyPaused(workspaceId: string) {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.workspaceId, workspaceId),
        eq(settings.key, agencyPausedKey)
      )
    )
    .limit(1);
  return rows[0]?.value === "true";
}

export async function setAgencyPaused(workspaceId: string, paused: boolean) {
  const value = String(paused);
  await db
    .insert(settings)
    .values({ key: agencyPausedKey, value, workspaceId })
    .onConflictDoUpdate({
      target: [settings.workspaceId, settings.key],
      set: { value },
    });
}
