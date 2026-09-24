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
import {
  browserRunNeeds,
  type BrowserRunNeed,
  parseBrowserOutcome,
  priceRubFromTotal,
} from "./outcome";

interface SpendRun {
  readonly createdByUserId: string;
  readonly id: string;
  readonly workspaceId: string;
}

/**
 * What the run says it charged: the amount in whole units when it could be
 * read, and whether the total named a currency other than the rouble. A bare
 * number is read as roubles, the way `parseBrowserOrder` reads it.
 */
interface SpendCharge {
  readonly foreignCurrency: boolean;
  readonly priceRub: number | undefined;
  /** The report speaks of a subscription or an automatic renewal. */
  readonly recurring: boolean;
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

const recurringChargePattern =
  /подписк|автопродл|автоплат|автосписан|продлева\p{L}*\s+автоматически|автоматическ\p{L}*\s+продл|пробн\p{L}*\s+период|subscri|auto-?renew|recurring|free trial/iu;

/**
 * Whether the errand or what the run reported speaks of a repeating charge.
 * The coordinator's own `recurring` flag is one opinion; this is a second one
 * read from the words, and either is enough to keep a payment off the limit.
 * A newsletter «подписка» trips it too, and costs only a question.
 */
export function mentionsRecurringCharge(
  ...texts: readonly (string | null | undefined)[]
) {
  return texts.some(
    (text) =>
      text !== null && text !== undefined && recurringChargePattern.test(text)
  );
}

type ReportedOutcome = Pick<
  ReturnType<typeof parseBrowserOutcome>,
  "needs" | "order" | "total"
>;

/**
 * Whether a finished run paid, read from what it reported rather than from
 * whether its order number parsed: a payment that went through with ORDER:
 * none, or with an order id no order row accepts, is still money gone. A run
 * that asked for nothing reported either a total or an order is a charge; so
 * is one that completed on a pre-approved payment without saying either way,
 * since it was told to stop with NEEDS: payment if it did not pay. A run that
 * failed or was cancelled without a word of a total is not.
 */
export function reportedCharge(
  outcome: ReportedOutcome,
  run: {
    readonly completed: boolean;
    readonly report: string | null | undefined;
  }
): SpendCharge | null {
  if (outcome.needs !== "none") return null;
  if (
    outcome.total === undefined &&
    outcome.order === undefined &&
    !run.completed
  ) {
    return null;
  }
  const foreignCurrency = totalIsForeign(outcome.total);
  return {
    foreignCurrency,
    priceRub:
      outcome.total === undefined || foreignCurrency
        ? undefined
        : priceRubFromTotal(outcome.total),
    recurring: mentionsRecurringCharge(run.report),
  };
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
    const { priceRub } = charge;
    const charged = await settleSpendReservation(run.id, {
      amountRub: priceRub ?? allowedRub,
      charged: true,
    });
    if (!charged) return undefined;
    const fee =
      charged.feeRub > 0
        ? `, plus up to ${formatRub(charged.feeRub)} in fees that can still be charged`
        : "";
    const overrun = charge.foreignCurrency
      ? `The run reported the total in another currency, not in roubles as the limit allowed; ${formatRub(allowedRub)} is counted against the limit. Tell the person plainly that this payment was not in roubles and give them the total exactly as the run reported it.`
      : priceRub === undefined
        ? `The run did not report a total that reads as roubles, so the whole ${formatRub(allowedRub)} it was allowed is counted against the limit. Tell the person the payment most likely went through, and that the real amount is on the shop's receipt.`
        : priceRub > allowedRub
          ? `The run reported ${formatRub(priceRub)}, more than the ${formatRub(allowedRub)} the limit allowed. Tell the person plainly that this payment went past what they allowed, and by how much.`
          : undefined;
    const renewal = charge.recurring
      ? "The run's report speaks of a subscription or an automatic renewal, which the limit never covers. Tell the person plainly and offer to cancel the renewal."
      : undefined;
    return [
      `This errand paid on its own under the person's standing spend limit: ${formatRub(charged.amountRub)}${fee}.`,
      overrun,
      renewal,
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
      // The stored summary keeps the run's labelled lines, so what the run
      // reported reads the same here as it did when it settled.
      const summary = parseBrowserOutcome(row.outcome);
      const charge =
        row.orderPriceRub === null
          ? reportedCharge(
              { needs, order: summary.order, total: summary.total },
              { completed: row.status === "done", report: row.outcome }
            )
          : {
              foreignCurrency: false,
              priceRub: row.orderPriceRub,
              recurring: mentionsRecurringCharge(row.outcome),
            };
      await settleBrowserRunSpend(
        {
          createdByUserId: row.createdByUserId,
          id: row.browserRunId,
          workspaceId: row.workspaceId,
        },
        needs,
        charge,
        row.completedAt ?? undefined,
        now
      );
    })
  );
}
