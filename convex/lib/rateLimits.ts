import { DAY, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import { RATE_COUNTER_CAP } from "./billingPolicy";

export const rateLimiter = new RateLimiter(components.rateLimiter);

// Component fixed windows are UTC-ms; Europe/Moscow calendar day/month lives in the key.
// Period is longer than any dayKey/monthKey lifetime so the bucket does not reset mid-period.
const PERIOD_MS = 400 * DAY;

export function periodConfig() {
  return {
    kind: "fixed window" as const,
    rate: RATE_COUNTER_CAP,
    period: PERIOD_MS,
    start: 0,
    capacity: RATE_COUNTER_CAP,
  };
}