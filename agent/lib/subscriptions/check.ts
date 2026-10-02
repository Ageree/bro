import type {
  ClaimedSubscription,
  SubscriptionCheck,
} from "@db/services/subscriptions";
import type { PageRead } from "./page";
import { conditionLabel, conditionMet, priceLabel, sameProduct } from "./price";

/** The longest a failing watch waits between tries. */
const maximumBackoffMs = 24 * 60 * 60_000;

/**
 * Decides what one price check found, from the page's reading. Only code
 * decides: a reading of the same product that meets the condition is news;
 * one of another product (the shop changed the page) or no reading is a
 * failure, and the third in a row ends the watch. Nothing from the page but
 * the number, its currency and the name the watch began with reaches the
 * outcome the report turn reads.
 */
export function judgePriceCheck(
  subscription: Pick<
    ClaimedSubscription,
    | "checkEverySeconds"
    | "condition"
    | "expiresAt"
    | "failures"
    | "source"
    | "state"
  >,
  reading: PageRead,
  now: Date
): SubscriptionCheck {
  const { condition, source, state } = subscription;
  const period = subscription.checkEverySeconds * 1_000;
  const product = source.name ? `«${source.name}»` : "the product";
  if (subscription.expiresAt.getTime() <= now.getTime()) {
    return {
      kind: "expired",
      outcome: {
        kind: "result",
        summary: `The price watch the person asked for has ended: ${product} (${source.url}) did not reach ${conditionLabel(condition, source.currency)} before ${subscription.expiresAt.toISOString()}. The last price read was ${priceLabel(state.last, source.currency)}, at ${state.lastSeenAt}. Say the watch ended and offer to start it again.`,
        urgency: "normal",
      },
    };
  }
  const failure = (error: string): SubscriptionCheck => ({
    error,
    kind: "failed",
    nextCheckAt: new Date(
      now.getTime() +
        Math.min(period * 2 ** (subscription.failures + 1), maximumBackoffMs)
    ),
    outcome: {
      kind: "blocked",
      summary: `The price watch the person asked for stopped: ${product} (${source.url}) could not be read three times in a row (${error}). The last price read was ${priceLabel(state.last, source.currency)}, at ${state.lastSeenAt}.`,
      userActionNeeded:
        "Offer a daily check of the page with the browser (a schedule), or a new watch if the link changed.",
    },
  });
  if (reading.kind === "blocked" || reading.kind === "unreachable") {
    return failure(`${reading.kind}: ${reading.reason}`);
  }
  if (reading.kind !== "price") return failure(reading.kind);
  if (reading.landedOn !== source.landedOn || !sameProduct(source, reading)) {
    return failure("another-product");
  }
  const next = {
    baseline: state.baseline,
    last: reading.amount,
    lastSeenAt: now.toISOString(),
  };
  if (!conditionMet(condition, reading.amount, state.baseline)) {
    return {
      kind: "quiet",
      nextCheckAt: new Date(now.getTime() + period),
      state: next,
    };
  }
  return {
    kind: "hit",
    outcome: {
      kind: "result",
      summary: `Price watch the person asked for: ${product} now costs ${priceLabel(reading.amount, source.currency)} (it was ${priceLabel(state.baseline, source.currency)} when the watch began; the person asked to hear about ${conditionLabel(condition, source.currency)}). Link: ${source.url}. The watch has ended; buying waits for the person's own message.`,
      urgency: "normal",
    },
    state: next,
  };
}
