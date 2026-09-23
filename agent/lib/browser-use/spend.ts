import {
  listSpendEntries,
  readSpendEntryForRun,
  readSpendLimit,
  settleSpendReservation,
} from "@db/services/spending";
import { formatRub, remainingForTarget } from "@shared/spending/limit";
import type { BrowserRunNeed, parseBrowserOrder } from "./outcome";

type BrowserOrder = NonNullable<ReturnType<typeof parseBrowserOrder>>;

interface SpendRun {
  readonly createdByUserId: string;
  readonly id: string;
  readonly workspaceId: string;
}

// A run parked on one of these is in the middle of paying: the charge may
// still land once the person's code or approval goes through.
const paymentInFlight = new Set<BrowserRunNeed>([
  "3ds",
  "email_code",
  "push",
  "sms_code",
]);

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
 * reported as a receipt; a run still waiting on a code keeps its reservation;
 * anything else ends without a charge and gives the money back to the month.
 */
export async function settleBrowserRunSpend(
  run: SpendRun,
  needs: BrowserRunNeed,
  order: BrowserOrder | null
) {
  const entry = await readSpendEntryForRun(run.id);
  if (entry?.status !== "reserved") return undefined;
  if (order) {
    const charged = await settleSpendReservation(run.id, {
      amountRub: order.priceRub,
      charged: true,
    });
    if (!charged) return undefined;
    const fee =
      charged.feeRub > 0
        ? `, plus up to ${formatRub(charged.feeRub)} in fees that can still be charged`
        : "";
    return [
      `This errand paid on its own under the person's standing spend limit: ${formatRub(charged.amountRub)}${fee}.`,
      await remainingLine(run, charged),
      "Tell the person as a receipt — what was bought, where, the total and the order number — and how much of the limit is left. They did not approve this payment in the conversation and do not need to now.",
    ]
      .filter((line) => line !== undefined)
      .join(" ");
  }
  if (paymentInFlight.has(needs)) return undefined;
  await settleSpendReservation(run.id, { charged: false });
  return "Nothing was charged under the person's standing spend limit, and the amount reserved for this errand is back in the month. If the run stopped before paying because the checkout did not match what the limit allowed — a higher total, an extra fee, a subscription — ask the person once, with the real total, before paying.";
}

/** A run that ended without settling normally releases its reservation. */
export async function releaseBrowserRunSpend(runId: string) {
  await settleSpendReservation(runId, { charged: false });
}
