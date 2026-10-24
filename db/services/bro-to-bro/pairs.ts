import { and, eq, isNull, or, sql } from "drizzle-orm";
import { broLinks, type db } from "@db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lock(transaction: Transaction, key: string) {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  );
}

/**
 * Serializes what changes between two workspaces (a link, its removal, a new
 * thread), whichever of them acts, so a limit counts committed rows only.
 */
export async function lockBroPair(
  transaction: Transaction,
  left: string,
  right: string
) {
  await lock(transaction, `bro_pair:${[left, right].toSorted().join("|")}`);
}

/** Serializes one workspace's daily limits. */
export async function lockBroWorkspace(
  transaction: Transaction,
  workspaceId: string
) {
  await lock(transaction, `bro_workspace:${workspaceId}`);
}

/**
 * The live rows of the link between two workspaces, one per direction.
 * `share` holds them as read until the transaction ends: a change of what
 * is open, or the link's removal, waits for it, and one under way is waited
 * for and then read as it committed.
 */
export async function readLivePairLinks(
  executor: Pick<typeof db, "select">,
  left: string,
  right: string,
  hold?: "share"
) {
  const rows = executor
    .select()
    .from(broLinks)
    .where(
      and(
        isNull(broLinks.removedAt),
        or(
          and(
            eq(broLinks.workspaceId, left),
            eq(broLinks.peerWorkspaceId, right)
          ),
          and(
            eq(broLinks.workspaceId, right),
            eq(broLinks.peerWorkspaceId, left)
          )
        )
      )
    );
  return hold === undefined ? rows : rows.for(hold);
}
