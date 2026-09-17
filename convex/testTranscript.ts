/**
 * The recorder behind cloud testing: where a test tenant's outbound lands
 * instead of a real iPhone, and how a run wipes itself clean between
 * scenarios.
 *
 * Every function here refuses a phone outside the fictional test range. That
 * guard is the reason the suite can be pointed at the production deployment
 * without a staging environment existing yet: the worst a misdirected run can
 * do is read and clear rows for a number no carrier assigns.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";
import { isTestPhone } from "./lib/testTenantPolicy";
import { findTenantByPhone } from "./lib/tenantLookup";
import type { MutationCtx } from "./_generated/server";

const channel = v.union(v.literal("imessage"), v.literal("telegram"));

const bubbleRow = v.object({
  at: v.number(),
  channel,
  text: v.string(),
  bubbles: v.array(v.string()),
  note: v.optional(v.string()),
});

function assertTestPhone(phoneE164: string): void {
  if (!isTestPhone(phoneE164)) {
    // Loud rather than silent: a suite that has drifted onto a real number
    // should fail its very first call, not quietly record nothing.
    throw new Error(`not a test phone: ${phoneE164}`);
  }
}

export const record = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    at: v.number(),
    channel,
    text: v.string(),
    bubbles: v.array(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    assertTestPhone(args.phoneE164);
    await ctx.db.insert("testTranscript", {
      phoneE164: args.phoneE164,
      at: args.at,
      channel: args.channel,
      text: args.text,
      bubbles: args.bubbles,
      ...(args.note ? { note: args.note } : {}),
    });
    return null;
  },
});

/** Everything this tenant has been told, oldest first. */
export const list = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.array(bubbleRow),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    assertTestPhone(args.phoneE164);
    const rows = await ctx.db
      .query("testTranscript")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .collect();
    return rows.map((row) => ({
      at: row.at,
      channel: row.channel,
      text: row.text,
      bubbles: row.bubbles,
      ...(row.note ? { note: row.note } : {}),
    }));
  },
});

/**
 * Put one test tenant back to a clean slate.
 *
 * Scenario isolation is not only the transcript: wakeups are keyed by phone
 * and outlive a run, so a reminder scheduled by one scenario would fire into
 * another. Browser state is on the tenant row and
 * would make the next errand read `busy`. The eve session history is cleared
 * separately by the reset route — it lives in eve, not here.
 */
export const reset = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.object({
    bubbles: v.number(),
    wakeups: v.number(),
    jobs: v.number(),
    orders: v.number(),
  }),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    assertTestPhone(args.phoneE164);

    const bubbles = await ctx.db
      .query("testTranscript")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .collect();
    for (const row of bubbles) await ctx.db.delete(row._id);

    const wakeups = await ctx.db
      .query("wakeups")
      .withIndex("by_tenant", (q) => q.eq("tenantPhone", args.phoneE164))
      .collect();
    for (const row of wakeups) await ctx.db.delete(row._id);

    const tenantRows = await resetTenantRow(ctx, args.phoneE164);

    return {
      bubbles: bubbles.length,
      wakeups: wakeups.length,
      jobs: tenantRows.jobs,
      orders: tenantRows.orders,
    };
  },
});

/**
 * Everything keyed by the tenant row rather than the phone, plus the row's own
 * per-conversation state.
 *
 * Clearing `photonConversationId` is what makes a rerun a real first contact:
 * `bindPhotonInbound` decides `firstBind` from exactly that field, and the
 * welcome letter hangs off `firstBind`. Without this the onboarding scenario
 * would pass once, on a fresh tenant, and never again — the worst kind of
 * test, one that goes quiet instead of failing.
 */
async function resetTenantRow(
  ctx: MutationCtx,
  phoneE164: string,
): Promise<{ jobs: number; orders: number }> {
  const tenant = await findTenantByPhone(ctx, phoneE164);
  if (!tenant) return { jobs: 0, orders: 0 };
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
    .collect();
  for (const row of jobs) await ctx.db.delete(row._id);
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
    .collect();
  for (const row of orders) await ctx.db.delete(row._id);
  await ctx.db.patch(tenant._id, {
    photonConversationId: undefined,
    photonUserId: undefined,
    photonNudgeSentAt: undefined,
    paywallSentDayKey: undefined,
    browserSessionId: undefined,
    browserLiveUrl: undefined,
    browserRunId: undefined,
    browserTask: undefined,
    browserStatus: undefined,
    browserStartedAt: undefined,
    browserStartingAt: undefined,
    browserStartingTask: undefined,
    browserPendingSteer: undefined,
    browserNeed: undefined,
    browserNeedSince: undefined,
    browserNeedDetail: undefined,
    browserPaying: undefined,
    browserPayHosts: undefined,
    browserNextTask: undefined,
    browserOutcome: undefined,
    browserProgressSent: undefined,
    browserLoginLinkSentAt: undefined,
  });
  return { jobs: jobs.length, orders: orders.length };
}
