import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  type AutoPaymentRequest,
  decideAutoPayment,
  spendLimitPolicySchema,
  type SpendLimitPolicy,
  wholeRubles,
} from "@shared/spending/limit";
import { browserRuns, db, orders, settings, spendEntries } from "@db";
import { ensureScope } from "./scope";

const spendLimitKey = "spend_limit";

// Released rows stay for the record but no longer count against the month.
const countedStatuses = ["reserved", "charged"] as const;

type Database = Pick<typeof db, "execute" | "select">;

function parsePolicy(value: string | undefined) {
  if (value === undefined) return undefined;
  try {
    const parsed = spendLimitPolicySchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function spendLimitRow(scope: AccessScope) {
  return and(
    eq(settings.workspaceId, scope.workspaceId),
    eq(settings.key, spendLimitKey)
  );
}

/**
 * Spending is decided and changed one at a time per workspace. The lock is
 * on the workspace rather than on the policy row, so it also holds while no
 * policy exists yet. The `neon-http` driver has no interactive transactions —
 * every statement is its own request — so there is no lock to take, and money
 * is not decided on it at all.
 */
async function lockWorkspaceSpending(tx: Database, scope: AccessScope) {
  if (env.DATABASE_DRIVER === "neon-http") {
    throw new Error(
      "The standing spend limit needs a transactional database driver."
    );
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`spend:${scope.workspaceId}`}, 0))`
  );
}

async function readPolicy(database: Database, scope: AccessScope) {
  const rows = await database
    .select({ value: settings.value })
    .from(settings)
    .where(spendLimitRow(scope))
    .limit(1);
  return parsePolicy(rows[0]?.value);
}

export async function readSpendLimit(scope: AccessScope) {
  return readPolicy(db, scope);
}

/**
 * Change the policy under the workspace lock, so two turns editing it at once
 * both land instead of the later one writing over the earlier. A policy with
 * no rules and no exclusions is no policy: the row goes.
 */
export async function updateSpendLimit(
  scope: AccessScope,
  change: (policy: SpendLimitPolicy | undefined) => SpendLimitPolicy
) {
  await ensureScope(scope);
  return db.transaction(async (tx) => {
    await lockWorkspaceSpending(tx, scope);
    const validated = spendLimitPolicySchema.parse(
      change(await readPolicy(tx, scope))
    );
    if (
      validated.rules.length === 0 &&
      validated.excludedMerchants.length === 0 &&
      validated.excludedCategories.length === 0
    ) {
      await tx.delete(settings).where(spendLimitRow(scope));
      return undefined;
    }
    const value = JSON.stringify(validated);
    await tx
      .insert(settings)
      .values({ key: spendLimitKey, value, workspaceId: scope.workspaceId })
      .onConflictDoUpdate({
        target: [settings.workspaceId, settings.key],
        set: { value },
      });
    return validated;
  });
}

function countedEntries(
  database: Database,
  scope: AccessScope,
  periodKey: string,
  exceptRunId?: string
) {
  return database
    .select({
      amountRub: spendEntries.amountRub,
      category: spendEntries.category,
      feeRub: spendEntries.feeRub,
      merchant: spendEntries.merchant,
    })
    .from(spendEntries)
    .where(
      and(
        eq(spendEntries.workspaceId, scope.workspaceId),
        eq(spendEntries.periodKey, periodKey),
        inArray(spendEntries.status, countedStatuses),
        exceptRunId === undefined
          ? undefined
          : ne(spendEntries.browserRunId, exceptRunId)
      )
    );
}

/** What already counts against the month: charged and still-reserved rows. */
export async function listSpendEntries(scope: AccessScope, periodKey: string) {
  return countedEntries(db, scope, periodKey);
}

/**
 * Decide an auto-payment and, when it fits, reserve it in the same
 * transaction under the workspace lock, so two errands deciding at once cannot
 * both take the last of the limit. A free payment reserves nothing: it takes
 * nothing from the month.
 *
 * `replacingRunId` is the errand's own earlier reservation, which a new
 * decision replaces: it is left out of the sum and released only when the new
 * one is granted, so a refusal leaves the old one standing.
 */
export async function reserveAutoPayment(
  scope: AccessScope,
  input: {
    readonly browserRunId: string;
    readonly periodKey: string;
    readonly replacingRunId?: string;
    readonly request: AutoPaymentRequest;
  }
) {
  await ensureScope(scope);
  return db.transaction(async (tx) => {
    await lockWorkspaceSpending(tx, scope);
    const policy = await readPolicy(tx, scope);
    const entries = await countedEntries(
      tx,
      scope,
      input.periodKey,
      input.replacingRunId
    );
    const decision = decideAutoPayment(policy, input.request, entries);
    if (!decision.allowed) return decision;
    if (input.replacingRunId !== undefined) {
      await tx
        .update(spendEntries)
        .set({ status: "released", updatedAt: new Date() })
        .where(
          and(
            eq(spendEntries.browserRunId, input.replacingRunId),
            eq(spendEntries.status, "reserved")
          )
        );
    }
    if (decision.basis === "limit") {
      await tx.insert(spendEntries).values({
        amountRub: wholeRubles(input.request.amount),
        browserRunId: input.browserRunId,
        category: input.request.category,
        feeRub: wholeRubles(input.request.fee),
        id: randomUUID(),
        merchant: input.request.merchant,
        periodKey: input.periodKey,
        workspaceId: scope.workspaceId,
      });
    }
    return decision;
  });
}

export async function readSpendEntryForRun(browserRunId: string) {
  const rows = await db
    .select()
    .from(spendEntries)
    .where(eq(spendEntries.browserRunId, browserRunId))
    .limit(1);
  return rows[0];
}

/**
 * Hand a reservation to the run that carries the errand on — a background
 * retry after an anti-bot wall, or a follow-up in the same browser — so the
 * payment it may still make stays counted.
 */
export async function moveSpendReservation(fromRunId: string, toRunId: string) {
  await db
    .update(spendEntries)
    .set({ browserRunId: toRunId, updatedAt: new Date() })
    .where(
      and(
        eq(spendEntries.browserRunId, fromRunId),
        eq(spendEntries.status, "reserved")
      )
    );
}

/**
 * Close a reservation once its run has settled. A charge records the amount
 * the run reported; a release gives the money back to the month. Only a
 * reserved row moves, so settling twice is harmless.
 */
export async function settleSpendReservation(
  browserRunId: string,
  outcome:
    | { readonly charged: true; readonly amountRub: number }
    | { readonly charged: false }
) {
  const [row] = await db
    .update(spendEntries)
    .set(
      outcome.charged
        ? {
            amountRub: wholeRubles(outcome.amountRub),
            status: "charged" as const,
            updatedAt: new Date(),
          }
        : { status: "released" as const, updatedAt: new Date() }
    )
    .where(
      and(
        eq(spendEntries.browserRunId, browserRunId),
        eq(spendEntries.status, "reserved")
      )
    )
    .returning();
  return row;
}

/**
 * Reservations still open on runs that settled a while ago: the settle that
 * should have closed them failed, or the run is parked on a code that never
 * came. Each comes with the order its run recorded, if any. Runs waiting for a
 * background retry, or handed over to one, are not stale.
 */
export async function listStaleSpendReservations(
  settledBefore: Date,
  limit: number
) {
  return db
    .select({
      browserRunId: spendEntries.browserRunId,
      completedAt: browserRuns.completedAt,
      createdByUserId: browserRuns.createdByUserId,
      orderPriceRub: orders.priceRub,
      outcome: browserRuns.outcome,
      workspaceId: browserRuns.workspaceId,
    })
    .from(spendEntries)
    .innerJoin(browserRuns, eq(browserRuns.id, spendEntries.browserRunId))
    .leftJoin(orders, eq(orders.browserRunId, spendEntries.browserRunId))
    .where(
      and(
        eq(spendEntries.status, "reserved"),
        isNotNull(browserRuns.completedAt),
        lt(browserRuns.completedAt, settledBefore),
        isNull(browserRuns.retryAt),
        isNull(browserRuns.retriedAsRunId)
      )
    )
    .limit(limit);
}

/**
 * A reservation made under a placeholder belongs to a run that was about to
 * start. One still under its placeholder long after is a start that died
 * between the two steps, and holds money for nothing.
 */
export async function releaseAbandonedSpendReservations(createdBefore: Date) {
  await db
    .update(spendEntries)
    .set({ status: "released", updatedAt: new Date() })
    .where(
      and(
        eq(spendEntries.status, "reserved"),
        sql`${spendEntries.browserRunId} LIKE 'pending:%'`,
        lt(spendEntries.createdAt, createdBefore)
      )
    );
}
