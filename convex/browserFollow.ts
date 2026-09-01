import { v, type Infer } from "convex/values";
import { type WorkflowId } from "@convex-dev/workflow";
import { internalAction, mutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertSecret } from "./secret";
import { hydrate, pollStatus } from "./lib/browseruse";
import {
  decideExistingWorkflow,
  maxPollRounds,
  nextFollowDecision,
  POLL_INTERVAL_MS,
  sameBrowserRun,
  wakeupIdempotencyKey,
  wakeupStepRetry,
  type WakeupPhase,
} from "./lib/browserFollowPolicy";
import { isLiveBrowserPoll } from "./lib/wakeupPolicy";
import { unscheduleCron } from "./lib/wakeupCrons";
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
    const phase: WakeupPhase = decision === "giveup" ? "giveup" : "done";
    await step.runAction(
      internal.browserFollow.wakeupAgent,
      {
        tenantPhone: args.tenantPhone,
        task: args.task,
        runId: args.runId,
        phase,
      },
      { retry: wakeupStepRetry, name: "wakeup" },
    );
    return { outcome: decision === "giveup" ? "timeout" : "done" };
  }
  await step.runAction(
    internal.browserFollow.wakeupAgent,
    {
      tenantPhone: args.tenantPhone,
      task: args.task,
      runId: args.runId,
      phase: "giveup",
    },
    { retry: wakeupStepRetry, name: "wakeup-giveup" },
  );
  return { outcome: "timeout" };
});

const WAKEUP_SCAN_PAGE = 100;

async function cancelLeftoverBrowserPolls(
  ctx: MutationCtx,
  tenantPhone: string,
): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const page = await ctx.db
      .query("wakeups")
      .withIndex("by_tenant", (q) => q.eq("tenantPhone", tenantPhone))
      .paginate({ numItems: WAKEUP_SCAN_PAGE, cursor });
    for (const row of page.page) {
      if (!isLiveBrowserPoll(row)) continue;
      await unscheduleCron(ctx, row._id);
      await ctx.db.patch(row._id, {
        status: "cancelled",
        recurMinutes: undefined,
        recurDailyHour: undefined,
      });
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
}

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
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof startResult> | { error: string }> => {
    assertSecret(args.secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.tenantPhone))
      .first();
    if (!tenant) return { error: "unknown tenant" };
    if (!sameBrowserRun(tenant.browserRunId, args.runId)) {
      return { error: "stale_run" };
    }

    if (tenant.browserWorkflowId) {
      const id = tenant.browserWorkflowId as WorkflowId;
      let statusOk = true;
      let statusType: string | undefined;
      try {
        const st = await workflow.status(ctx, id);
        statusType = st.type;
      } catch (err) {
        console.error("browser follow status failed", err);
        statusOk = false;
      }
      const next = decideExistingWorkflow({
        statusOk,
        statusType,
        workflowRunId: tenant.browserWorkflowRunId,
        runId: args.runId,
      });
      if (next === "retry_later") return { error: "retry_later" };
      if (next === "reuse") {
        await cancelLeftoverBrowserPolls(ctx, args.tenantPhone);
        return { workflowId: id, reused: true };
      }
      if (next === "cancel_then_start") {
        try {
          await workflow.cancel(ctx, id);
        } catch (err) {
          console.error("browser follow cancel failed", err);
          return { error: "retry_later" };
        }
      }
    }

    const workflowId = await workflow.start(ctx, internal.browserFollow.followThrough, {
      tenantPhone: args.tenantPhone,
      runId: args.runId,
      sessionId: args.sessionId,
      task: args.task,
      startedAt: args.startedAt,
    });
    await ctx.db.patch(tenant._id, {
      browserWorkflowId: workflowId,
      browserWorkflowRunId: args.runId,
    });
    await cancelLeftoverBrowserPolls(ctx, args.tenantPhone);
    return { workflowId, reused: false };
  },
});

export const cancelFollowThrough = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    runId: v.string(),
  },
  returns: v.object({
    cancelled: v.number(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, { secret, tenantPhone, runId }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", tenantPhone))
      .first();
    if (!tenant?.browserWorkflowId) return { cancelled: 0 };
    if (!sameBrowserRun(tenant.browserRunId, runId)) {
      return { cancelled: 0, error: "stale_run" };
    }
    const id = tenant.browserWorkflowId as WorkflowId;
    try {
      const st = await workflow.status(ctx, id);
      if (st.type === "inProgress") {
        await workflow.cancel(ctx, id);
      }
    } catch (err) {
      console.error("browser follow cancel failed", err);
      return { cancelled: 0, error: "retry_later" };
    }
    await ctx.db.patch(tenant._id, {
      browserWorkflowId: undefined,
      browserWorkflowRunId: undefined,
    });
    return { cancelled: 1 };
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
  handler: async (ctx, args): Promise<Infer<typeof pollReturn>> => {
    const tenant = await ctx.runQuery(internal.tenants.getByPhoneInternal, {
      phoneE164: args.tenantPhone,
    });
    if (!sameBrowserRun(tenant?.browserRunId, args.runId)) {
      return { status: tenant?.browserStatus ?? "unknown", now: Date.now(), stale: true };
    }
    const cheap = await pollStatus(args.runId, args.sessionId);
    const run =
      cheap.liveUrl || cheap.result
        ? cheap
        : await hydrate(args.runId, cheap.sessionId ?? args.sessionId);
    const wrote = await ctx.runMutation(internal.tenants.patchBrowserInternal, {
      phoneE164: args.tenantPhone,
      runId: args.runId,
      browserStatus: run.status,
      browserSessionId: run.sessionId,
      browserLiveUrl: run.liveUrl,
    });
    if (wrote.stale) {
      return { status: run.status, now: Date.now(), stale: true };
    }
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
    runId: v.string(),
    phase: v.union(v.literal("done"), v.literal("giveup")),
  },
  returns: v.object({
    ok: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    { tenantPhone, task, runId, phase },
  ): Promise<{ ok: boolean; reason?: string }> => {
    const eveUrl = process.env.EVE_URL;
    // ponytail: no EVE_URL on this deployment → silent no-op
    if (!eveUrl) return { ok: false, reason: "no EVE_URL" };
    const secret = process.env.BRO_INTERNAL_SECRET ?? "";
    const claimed = await ctx.runMutation(internal.tenants.claimBrowserWakeup, {
      phoneE164: tenantPhone,
      runId,
      phase,
    });
    if (!claimed.ok) {
      if (claimed.reason === "duplicate") return { ok: true, reason: "duplicate" };
      if (claimed.reason === "pending_in_flight") {
        throw new Error("pending_claim_in_flight");
      }
      return { ok: false, reason: claimed.reason };
    }
    if (!claimed.conversationId) return { ok: false, reason: "no conversation" };

    // pending vs sent: a crash after claim must throw, not succeed as duplicate.
    // Wakeup step retries: 9 attempts, 500ms * 2^(k-1) with jitter 0.5..1.5.
    // Worst-case wait before last attempt is 63750ms > 60s lease — see
    // wakeupRetryWaitBeforeLastMs. Failed POST still release()s immediately.
    try {
      const res = await fetch(`${eveUrl}/internal/wakeup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret,
          tenantPhone,
          conversationId: claimed.conversationId,
          inkboxHandle: claimed.inkboxHandle,
          kind: "browser_poll",
          payload: task,
          runId,
          idempotencyKey: wakeupIdempotencyKey(runId, phase),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        throw new Error(`eve wakeup ${res.status}`);
      }
    } catch (err) {
      await ctx.runMutation(internal.tenants.releaseBrowserWakeup, {
        phoneE164: tenantPhone,
        runId,
        phase,
      });
      throw err;
    }
    await ctx.runMutation(internal.tenants.confirmBrowserWakeup, {
      phoneE164: tenantPhone,
      runId,
      phase,
    });
    return { ok: true };
  },
});
