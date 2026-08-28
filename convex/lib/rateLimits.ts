import { RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import {
  RATE_COUNTER_CAP,
  RATE_WINDOW_PERIOD_MS,
  RATE_WINDOW_START_MS,
} from "./billingPolicy";

export const rateLimiter = new RateLimiter(components.rateLimiter);

// Component windows are UTC-ms only. Calendar day/month is the key (Europe/Moscow).
// Period ~1014y from epoch so the first UTC boundary is centuries away.
export function periodConfig() {
  return {
    kind: "fixed window" as const,
    rate: RATE_COUNTER_CAP,
    period: RATE_WINDOW_PERIOD_MS,
    start: RATE_WINDOW_START_MS,
    capacity: RATE_COUNTER_CAP,
  };
}
