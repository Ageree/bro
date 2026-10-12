import type { agencyActionClasses } from "@db";

export type AgencyActionClass = (typeof agencyActionClasses)[number];

/** The window the budget counts over: a day. */
export const agencyBudgetWindowMs = 24 * 60 * 60 * 1000;

/** Actions Bro takes on its own in one workspace, across every class, a day. */
const agencyDailyTotal = 15;

/**
 * Per class, a day. `other` has no authorized action yet, so it gets none:
 * a class without a limit must not become an open door.
 */
const dailyLimits: Record<AgencyActionClass, number> = {
  call: 3,
  calendar: 6,
  other: 0,
  send: 8,
  submit: 3,
};

/**
 * Why the day's budget refuses one more action of `actionClass`, given what
 * it already counted (`agencyBudgetUsage`), or undefined while it has room.
 */
export function budgetRefusal(
  usage: ReadonlyMap<AgencyActionClass, number>,
  actionClass: AgencyActionClass
) {
  const total = [...usage.values()].reduce((sum, count) => sum + count, 0);
  if (total >= agencyDailyTotal) {
    return "Nothing was done: Bro has reached its limit of actions taken on its own for today. Do not retry it today; say so in the hand-off.";
  }
  if ((usage.get(actionClass) ?? 0) >= dailyLimits[actionClass]) {
    return `Nothing was done: Bro has reached its limit of ${actionClass} actions for today. Do not retry it today; say so in the hand-off.`;
  }
  return undefined;
}
