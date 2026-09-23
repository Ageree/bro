import {
  listSpendEntries,
  listStaleSpendReservations,
  readSpendEntryForRun,
  readSpendLimit,
  releaseAbandonedSpendReservations,
  settleSpendReservation,
} from "@db/services/spending";
import { z } from "zod";
import { formatRub, remainingForTarget } from "@shared/spending/limit";
import { browserRunNeeds, type BrowserRunNeed } from "./outcome";

interface SpendRun {
  readonly createdByUserId: string;
  readonly id: string;
  readonly workspaceId: string;
}

/**
 * What the run says it charged: the amount in whole units, and whether the
 * total named a currency other than the rouble. A bare number is read as
 * roubles, the way `parseBrowserOrder` reads it.
 */
export interface SpendCharge {
  readonly foreignCurrency: boolean;
  readonly priceRub: number;
}

// A run parked on one of these is in the middle of paying: the charge may
// still land once the person's code or approval goes through.
const paymentInFlight = new Set<BrowserRunNeed>([
  "3ds",
  "email_code",
  "push",
  "sms_code",
]);

// A code that never came is not coming: after this the reservation goes back.
const inFlightHoldMs = 24 * 60 * 60_000;

const foreignCurrencyPattern =
  /[$€£¥₸₴]|\b(?:usd|eur|gbp|cny|kzt|try|aed|byn|uah)\b|доллар|евро|юан|тенге|лир/iu;

/** Whether a reported total names a currency other than the rouble. */
export function totalIsForeign(total: string | undefined) {
  return total !== undefined && foreignCurrencyPattern.test(total);
}

async function remainingLine(
  run: SpendRun,
  entry: NonNullable<Awaited<ReturnType<typeof readSpendEntryForRun>>>
) {
  const scope = { userId: run.createdByUserId, workspaceId: run.workspaceId };
  const [policy, entries] = await Promise.all([
    readSpendLimit(scope),
    listSpendEntries(scope, entry.periodKey),
  ]);
  const remaining = policy && remainingForTarget(policy, entry, entries);
  return remaining === undefined
    ? undefined
    : `Left under the limit this month: ${formatRub(remaining)}.`;
}

/**
 * Close the spend-limit reservation of a settled run and say what the
 * coordinator should tell the person about it. An order is a charge and gets
 * reported as a receipt; a run still waiting on a code keeps its reservation
 * for a day; anything else ends without a charge and gives the money back to
 * the month.
 *
 * The ledger records what was paid, not what was allowed: a charge the run
 * reports above the reserved amount, or in another currency, has already
 * happened, so it is recorded — the reserved amount when the real one cannot
 * be read in roubles — and the person is told plainly that it went past what
 * they allowed.
 */
export async function settleBrowserRunSpend(
  run: SpendRun,
  needs: BrowserRunNeed,
  charge: SpendCharge | null,
  settledAt?: Date,
  now = new Date()
) {
  const entry = await readSpendEntryForRun(run.id);
  if (entry?.status !== "reserved") return undefined;
  if (charge) {
    const allowedRub = entry.amountRub + entry.feeRub;
    const charged = await settleSpendReservation(run.id, {
      amountRub: charge.foreignCurrency ? entry.amountRub : charge.priceRub,
      charged: true,
    });
    if (!charged) return undefined;
    const fee =
      charged.feeRub > 0
        ? `, plus up to ${formatRub(charged.feeRub)} in fees that can still be charged`
        : "";
    const overrun = charge.foreignCurrency
      ? `The run reported the total in another currency, not in roubles as the limit allowed; ${formatRub(entry.amountRub)} is counted against the limit. Tell the person plainly that this payment was not in roubles and give them the total exactly as the run reported it.`
      : charge.priceRub > allowedRub
        ? `The run reported ${formatRub(charge.priceRub)}, more than the ${formatRub(allowedRub)} the limit allowed. Tell the person plainly that this payment went past what they allowed, and by how much.`
        : undefined;
    return [
      `This errand paid on its own under the person's standing spend limit: ${formatRub(charged.amountRub)}${fee}.`,
      overrun,
      await remainingLine(run, charged),
      "Tell the person as a receipt — what was bought, where, the total and the order number — and how much of the limit is left. They did not approve this payment in the conversation and do not need to now.",
    ]
      .filter((line) => line !== undefined)
      .join(" ");
  }
  if (
    paymentInFlight.has(needs) &&
    (settledAt === undefined ||
      now.getTime() - settledAt.getTime() < inFlightHoldMs)
  ) {
    return undefined;
  }
  await settleSpendReservation(run.id, { charged: false });
  return "Nothing was charged under the person's standing spend limit, and the amount reserved for this errand is back in the month. If the run stopped before paying because the checkout did not match what the limit allowed — a higher total, an extra fee, a subscription — ask the person once, with the real total, before paying.";
}

/** A run that ended without settling normally releases its reservation. */
export async function releaseBrowserRunSpend(runId: string) {
  await settleSpendReservation(runId, { charged: false });
}

const needsLine = /^needs:[ \t]*([a-z0-9_]+)[ \t]*$/imu;
const needSchema = z.enum(browserRunNeeds);
const staleAfterMs = 10 * 60_000;
const abandonedAfterMs = 60 * 60_000;
const staleLimit = 25;

/**
 * Close what the settle path could not. A reservation still open well after
 * its run settled is closed from what the run left behind — its recorded
 * order and its `Needs:` line — and one still under a start's placeholder is
 * released. The poller runs this every minute, so a ledger that was briefly
 * unreachable when a run settled costs the month nothing for long.
 */
export async function reconcileSpendReservations(now = new Date()) {
  await releaseAbandonedSpendReservations(
    new Date(now.getTime() - abandonedAfterMs)
  );
  const stale = await listStaleSpendReservations(
    new Date(now.getTime() - staleAfterMs),
    staleLimit
  );
  await Promise.all(
    stale.map(async (row) => {
      const needs =
        needSchema.safeParse(needsLine.exec(row.outcome ?? "")?.[1]).data ??
        "none";
      await settleBrowserRunSpend(
        {
          createdByUserId: row.createdByUserId,
          id: row.browserRunId,
          workspaceId: row.workspaceId,
        },
        needs,
        row.orderPriceRub === null
          ? null
          : { foreignCurrency: false, priceRub: row.orderPriceRub },
        row.completedAt ?? undefined,
        now
      );
    })
  );
}
