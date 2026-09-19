import { readBillingState } from "@db/services/billing";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { countUsage } from "@db/services/usage";
import { yooKassaConfigured } from "@db/services/yookassa";
import type { AccessScope } from "@shared/identity/access-scope";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import {
  browserQuotaNote,
  browserRunAllowance,
  localDayKey,
  localMonthKey,
  messageAllowance,
  messagePaywallText,
  withinAllowance,
} from "./limits";

/**
 * The checkout link, or nothing in free mode. A deployment whose origin cannot
 * be resolved is treated the same way: an unpayable link in a paywall bubble is
 * worse than a bubble without one.
 */
function payUrl() {
  if (!yooKassaConfigured()) return undefined;
  try {
    return new URL("/api/pay", applicationOrigin()).toString();
  } catch (error) {
    console.warn("[billing] the pay link has no resolvable origin", {
      cause: error,
    });
    return undefined;
  }
}

async function billingWindow(scope: AccessScope, now: Date) {
  const [billing, timeZone] = await Promise.all([
    readBillingState(scope, now),
    readWorkspaceTimeZone(scope),
  ]);
  return { paid: billing.paid, timeZone };
}

/**
 * Counts one inbound message and decides what the channel does with it. Over
 * the limit the person is told once per local day; the messages after that are
 * dropped in silence rather than turning the paywall into a flood of its own.
 *
 * With `USAGE_LIMITS` off (the closed-beta default) every message is allowed
 * and `countUsage` is skipped, since it exists only to feed this gate.
 */
export async function messageQuotaGate(scope: AccessScope, now = new Date()) {
  if (env.USAGE_LIMITS === "off")
    return { allowed: true, paywallText: undefined };

  const { paid, timeZone } = await billingWindow(scope, now);
  const dayKey = localDayKey(now, timeZone);
  const count = await countUsage(scope, "messages", dayKey);
  if (withinAllowance(count, messageAllowance(paid))) {
    return { allowed: true, paywallText: undefined };
  }

  const notices = await countUsage(scope, "paywall_notices", dayKey);
  return {
    allowed: false,
    paywallText: notices === 1 ? messagePaywallText(payUrl()) : undefined,
  };
}

/**
 * Counts one browser errand against the local month. The refusal is written for
 * the model, which relays it to the person in its own words.
 *
 * With `USAGE_LIMITS` off (the closed-beta default) every errand is allowed
 * and `countUsage` is skipped, since it exists only to feed this gate.
 */
export async function browserRunQuotaGate(
  scope: AccessScope,
  now = new Date()
) {
  if (env.USAGE_LIMITS === "off") return { allowed: true, note: undefined };

  const { paid, timeZone } = await billingWindow(scope, now);
  const count = await countUsage(
    scope,
    "browser_runs",
    localMonthKey(now, timeZone)
  );
  if (withinAllowance(count, browserRunAllowance(paid))) {
    return { allowed: true, note: undefined };
  }
  return { allowed: false, note: browserQuotaNote(payUrl()) };
}
