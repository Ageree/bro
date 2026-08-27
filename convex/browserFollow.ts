import { v } from "convex/values";
import { type WorkflowId } from "@convex-dev/workflow";
import { internalAction, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertSecret } from "./secret";
import { hydrate, pollStatus } from "./lib/browseruse";
import {
  maxPollRounds,
  nextFollowDecision,
  POLL_INTERVAL_MS,
} from "./lib/browserFollowPolicy";
import { workflow } from "./workflow";

const startResult = v.object({
  workflowId: v.string(),
  reused: v.boolean(),
});

const followOutcome = v.object({
  outcome: v.union(
    v.literal("done"),
    v.literal("timeout"),
    v.literal("stale"),
  ),
});

export const followThrough = workflow.define({
  args: {
    tenantPhone: v.string(),
    runId: v.string(),
    sessionId: v.optional(v.string()),
    task: v.string(),
    startedAt: v.number(),
  },
  returns: followOutcome,
  workpoolOptions: {
    retryActionsByDefault: true,
    defaultRetryBehavior: {
      maxAttempts: 5,
      initialBackoffMs: 500,
      base: 2,
    },
  },
}).handler(async (step, args): Promise<{
  outcome: "done" | "timeout" | "stale";
}> => {
  const cap = maxPollRounds() + 2;
  for (let i = 0; i < cap; i++) {
    await step.sleep(POLL_INTERVAL_MS, { name: `wait-${i}` });
    const poll = await step.runAction(
      internal.browserFollow.pollRun,
      {
        tenantPhone: args.tenantPhone,
        runId: args.runId,
        sessionId: args.sessionId,
      },
      { retry: true, name: `poll-${i}` },
    );
    if (poll.stale) return { outcome: "stale" };
    const decision = nextFollowDecision({
      status: poll.status,
      startedAt: args.startedAt,
      now: poll.now,
    });
    if (decision === "sleep") continue;
    await step.runAction(
      internal.browserFollow.wakeupAgent,
      { tenantPhone: args.tenantPhone, task: args.task },
      { retry: true, name: "wakeup" },
    );
    return { outcome: decision === "giveup" ? "timeout" : "done" };
  }
  await step.runAction(
    internal.browserFollow.wakeupAgent,
    { tenantPhone: args.tenantPhone, task: args.task },
    { retry: true, name: "wakeup-giveup" },
  );
  return { outcome: "timeout" };
});

export const startFollowThrough = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    runId: v.string(),
    sessionId: v.optional(v.string()),
    task: v.string(),
    startedAt: v.number(),
  },
  returns: v.union(startResult, v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.tenantPhone))
      .first();
    if (!tenant) return { error: "unknown tenant" };

    const leftover = await ctx.db
      .query("wakeups")
      .withIndex("by_tenant", (q) => q.eq("tenantPhone", args.tenantPhone))
      .take(100);
    for (const row of leftover) {
      if (row.status === "scheduled" && row.kind === "browser_poll") {
        await ctx.db.patch(row._id, { status: "cancelled" });
      }
    }

    if (tenant.browserWorkflowId) {
      const id = tenant.browserWorkflowId as WorkflowId;
      try {
        const st = await workflow.status(ctx, id);
        if (st.type === "inProgress" && tenant.browserRunId === args.runId) {
          return { workflowId: id, reused: true };
        }
        if (st.type === "inProgress") {
          await workflow.cancel(ctx, id);
        }
      } catch (err) {
        console.error("browser follow status/cancel failed", err);
      }
    }

    const workflowId = await workflow.start(ctx, internal.browserFollow.followThrough, {
      tenantPhone: args.tenantPhone,
      runId: args.runId,
      sessionId: args.sessionId,
      task: args.task,
      startedAt: args.startedAt,
    });
    await ctx.db.patch(tenant._id, { browserWorkflowId: workflowId });
    return { workflowId, reused: false };
  },
});

export const cancelFollowThrough = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, { secret, tenantPhone }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", tenantPhone))
      .first();
    if (!tenant?.browserWorkflowId) return 0;
    const id = tenant.browserWorkflowId as WorkflowId;
    let n = 0;
    try {
      const st = await workflow.status(ctx, id);
      if (st.type === "inProgress") {
        await workflow.cancel(ctx, id);
        n = 1;
      }
    } catch (err) {
      console.error("browser follow cancel failed", err);
    }
    await ctx.db.patch(tenant._id, { browserWorkflowId: undefined });
    return n;
  },
});

const pollReturn = v.object({
  status: v.string(),
  now: v.number(),
  stale: v.boolean(),
  sessionId: v.optional(v.string()),
  liveUrl: v.optional(v.string()),
  result: v.optional(v.string()),
});

export const pollRun = internalAction({
  args: {
    tenantPhone: v.string(),
    runId: v.string(),
    sessionId: v.optional(v.string()),
  },
  returns: pollReturn,
  handler: async (ctx, args) => {
    const tenant = await ctx.runQuery(internal.tenants.getByPhoneInternal, {
      phoneE164: args.tenantPhone,
    });
    if (tenant && tenant.browserRunId && tenant.browserRunId !== args.runId) {
      return { status: tenant.browserStatus ?? "unknown", now: Date.now(), stale: true };
    }
    const cheap = await pollStatus(args.runId, args.sessionId);
    const run =
      cheap.liveUrl || cheap.result
        ? cheap
        : await hydrate(args.runId, cheap.sessionId ?? args.sessionId);
    await ctx.runMutation(internal.tenants.patchBrowserInternal, {
      phoneE164: args.tenantPhone,
      browserStatus: run.status,
      browserSessionId: run.sessionId,
      browserLiveUrl: run.liveUrl,
    });
    return {
      status: run.status,
      now: Date.now(),
      stale: false,
      sessionId: run.sessionId,
      liveUrl: run.liveUrl,
      result: run.result,
    };
  },
});

export const wakeupAgent = internalAction({
  args: {
    tenantPhone: v.string(),
    task: v.string(),
  },
  returns: v.object({
    ok: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, { tenantPhone, task }) => {
    const eveUrl = process.env.EVE_URL;
    // ponytail: no EVE_URL on this deployment → silent no-op
    if (!eveUrl) return { ok: false, reason: "no EVE_URL" };
    const secret = process.env.BRO_INTERNAL_SECRET ?? "";
    const tenant = await ctx.runQuery(internal.tenants.getByPhoneInternal, {
      phoneE164: tenantPhone,
    });
    if (!tenant?.inkboxConversationId) {
      return { ok: false, reason: "no conversation" };
    }
    const res = await fetch(`${eveUrl}/internal/wakeup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        tenantPhone,
        conversationId: tenant.inkboxConversationId,
        inkboxHandle: tenant.inkboxHandle,
        kind: "browser_poll",
        payload: task,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`eve wakeup ${res.status}`);
    }
    return { ok: true };
  },
});
