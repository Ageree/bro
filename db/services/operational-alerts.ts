import { and, eq, sql } from "drizzle-orm";
import { db, operationalAlerts } from "@db";

/** Longer than a Telegram send may take, shorter than any repeat window. */
const claimLeaseMs = 2 * 60_000;

/**
 * Claims the right to send one alert. A key that has never fired, or was
 * cleared since it last fired, is claimed at once. After that it is claimed
 * again only once `repeatAfterMs` has passed, or when the value fell to half
 * of what the last alert reported and by at least `minimumDrop`. The whole
 * decision is one conditional upsert, so two schedule ticks that read the same
 * value cannot both send.
 *
 * The claim is a lease, not yet a sent alert: `last_sent_at` is stamped so
 * that the repeat window ends two minutes from now, and only
 * `confirmOperationalAlert` moves it to the real send time. A sender that died
 * between the claim and the send leaves an alert the next tick takes again,
 * instead of silence for the whole window. The stamp is returned as the
 * claim's token; undefined when the alert is not due.
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
  const claim = new Date(
    repeatBefore.getTime() + Math.min(claimLeaseMs, repeatAfterMs)
  );
  const claimed = await db
    .insert(operationalAlerts)
    .values({ key, lastSentAt: claim, lastValue: value, updatedAt: now })
    .onConflictDoUpdate({
      target: operationalAlerts.key,
      set: { lastSentAt: claim, lastValue: value, updatedAt: now },
      setWhere: sql`${operationalAlerts.lastSentAt} IS NULL
        OR ${operationalAlerts.lastSentAt} < ${repeatBefore}
        OR (
          ${operationalAlerts.lastValue} > 0
          AND excluded.last_value <= ${operationalAlerts.lastValue} / 2
          AND ${operationalAlerts.lastValue} - excluded.last_value >= ${minimumDrop}
        )`,
    })
    .returning({ key: operationalAlerts.key });
  return claimed.length > 0 ? claim : undefined;
}

/**
 * The claimed alert reached the owner: the repeat window starts at `sentAt`.
 * Nothing when the claim is no longer the latest one, or the key was cleared
 * since: that newer state stands.
 */
export async function confirmOperationalAlert(
  key: string,
  claim: Date,
  sentAt: Date
) {
  await db
    .update(operationalAlerts)
    .set({ lastSentAt: sentAt, updatedAt: sentAt })
    .where(
      and(
        eq(operationalAlerts.key, key),
        eq(operationalAlerts.lastSentAt, claim)
      )
    );
}

/**
 * The claimed alert never reached anyone, so the next tick may try at once.
 * Only this claim is given up: a newer one, taken after the key was cleared
 * and claimed again, is left to its own sender.
 */
export async function releaseOperationalAlertClaim(
  key: string,
  claim: Date,
  now = new Date()
) {
  await db
    .update(operationalAlerts)
    .set({ lastSentAt: null, lastValue: null, updatedAt: now })
    .where(
      and(
        eq(operationalAlerts.key, key),
        eq(operationalAlerts.lastSentAt, claim)
      )
    );
}

/**
 * Forgets that the alert fired: the condition is over. The next claim goes
 * through at once.
 */
export async function clearOperationalAlert(key: string, now = new Date()) {
  await db
    .update(operationalAlerts)
    .set({ lastSentAt: null, lastValue: null, updatedAt: now })
    .where(eq(operationalAlerts.key, key));
}
