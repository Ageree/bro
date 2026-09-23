import { eq, sql } from "drizzle-orm";
import { db, operationalAlerts } from "@db";

/**
 * Claims the right to send one alert. A key that has never fired, or was
 * cleared since it last fired, is claimed at once. After that it is claimed
 * again only once `repeatAfterMs` has passed, or when the value fell to half
 * of what the last alert reported and by at least `minimumDrop`. The whole
 * decision is one conditional upsert, so two schedule ticks that read the same
 * value cannot both send.
 */
export async function claimOperationalAlert(
  key: string,
  value: number,
  {
    minimumDrop,
    now = new Date(),
    repeatAfterMs,
  }: {
    readonly minimumDrop: number;
    readonly now?: Date;
    readonly repeatAfterMs: number;
  }
) {
  const repeatBefore = new Date(now.getTime() - repeatAfterMs);
  const claimed = await db
    .insert(operationalAlerts)
    .values({ key, lastSentAt: now, lastValue: value, updatedAt: now })
    .onConflictDoUpdate({
      target: operationalAlerts.key,
      set: { lastSentAt: now, lastValue: value, updatedAt: now },
      setWhere: sql`${operationalAlerts.lastSentAt} IS NULL
        OR ${operationalAlerts.lastSentAt} < ${repeatBefore}
        OR (
          ${operationalAlerts.lastValue} > 0
          AND excluded.last_value <= ${operationalAlerts.lastValue} / 2
          AND ${operationalAlerts.lastValue} - excluded.last_value >= ${minimumDrop}
        )`,
    })
    .returning({ key: operationalAlerts.key });
  return claimed.length > 0;
}

/**
 * Forgets that the alert fired: the condition is over, or the alert that was
 * claimed never reached anyone. The next claim goes through at once.
 */
export async function clearOperationalAlert(key: string, now = new Date()) {
  await db
    .update(operationalAlerts)
    .set({ lastSentAt: null, lastValue: null, updatedAt: now })
    .where(eq(operationalAlerts.key, key));
}
