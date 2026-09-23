import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  type AutoPaymentRequest,
  decideAutoPayment,
  spendLimitPolicySchema,
  type SpendLimitPolicy,
  wholeRubles,
} from "@shared/spending/limit";
import { db, settings, spendEntries } from "@db";
import { ensureScope } from "./scope";

const spendLimitKey = "spend_limit";

// Released rows stay for the record but no longer count against the month.
const countedStatuses = ["reserved", "charged"] as const;

type Database = Pick<typeof db, "select">;

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

export async function readSpendLimit(scope: AccessScope) {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(spendLimitRow(scope))
    .limit(1);
  return parsePolicy(rows[0]?.value);
}

/** A policy with no rules and no exclusions is no policy: the row goes. */
export async function saveSpendLimit(
  scope: AccessScope,
  policy: SpendLimitPolicy
) {
  const validated = spendLimitPolicySchema.parse(policy);
  if (validated.rules.length === 0 && validated.excluded.length === 0) {
    await db.delete(settings).where(spendLimitRow(scope));
    return undefined;
  }
  await ensureScope(scope);
  const value = JSON.stringify(validated);
  await db
    .insert(settings)
    .values({ key: spendLimitKey, value, workspaceId: scope.workspaceId })
    .onConflictDoUpdate({
      target: [settings.workspaceId, settings.key],
      set: { value },
    });
  return validated;
}

function countedEntries(
  database: Database,
  scope: AccessScope,
  periodKey: string
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
        inArray(spendEntries.status, countedStatuses)
      )
    );
}

/** What already counts against the month: charged and still-reserved rows. */
export async function listSpendEntries(scope: AccessScope, periodKey: string) {
  return countedEntries(db, scope, periodKey);
}

/**
 * Decide an auto-payment and, when it fits, reserve it in the same
 * transaction. The policy row is locked while the month is summed, so two
 * errands deciding at once are serialised and cannot both take the last of
 * the limit. A free payment reserves nothing: it takes nothing from the month.
 */
export async function reserveAutoPayment(
  scope: AccessScope,
  input: {
    readonly browserRunId: string;
    readonly periodKey: string;
    readonly request: AutoPaymentRequest;
  }
) {
  await ensureScope(scope);
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(spendLimitRow(scope))
      .for("update");
    const policy = parsePolicy(rows[0]?.value);
    const entries = await countedEntries(tx, scope, input.periodKey);
    const decision = decideAutoPayment(policy, input.request, entries);
    if (decision.allowed && decision.basis === "limit") {
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
 * the run reported; a release gives the money back to the month. Only a reserved row moves, so settling
 * twice is harmless.
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
