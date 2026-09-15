import { v, type Infer } from "convex/values";
import { type WorkflowCtx, type WorkflowId } from "@convex-dev/workflow";
import {
  internalAction,
  internalQuery,
  mutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { assertSecret } from "./secret";
import { cancelRun, hydrate, pollStatus, stopBrowserForSession } from "./lib/browseruse";
import {
  loginChatText,
  isLoginWaitTask,
  loginPageFromTask,
} from "./lib/browserProfilePolicy";
import { errandStartUrl } from "./lib/browserStartPolicy";
import { shouldSendLoginLink } from "./lib/browserLivePolicy";
import {
  decideExistingWorkflow,
  followSleepMs,
  isFollowTerminal,
  maxPollRounds,
  nextFollowDecision,
  persistableStatus,
  sameBrowserRun,
  STALLED_STATUS,
  UNKNOWN_STATUS,
  wakeupIdempotencyKey,
  wakeupStepRetry,
  type WakeupPhase,
} from "./lib/browserFollowPolicy";
import { needsHuman, parseCloudOutcome, type CloudNeed } from "./lib/browserOutcomePolicy";
import { isLiveBrowserPoll } from "./lib/wakeupPolicy";
import { unscheduleCron } from "./lib/wakeupCrons";
import { findTenantByPhone } from "./lib/tenantLookup";
import { workflow } from "./workflow";

/** Cloud runs stop responding to human input after this long parked on a
 *  need (code/3DS/captcha/password/missing data) — sweepWaiting gives up. */
const NEED_TIMEOUT_MS = 40 * 60_000;

const NEED_NOUN: Record<string, string> = {
  sms_code: "кода",
  email_code: "кода",
  push: "подтверждения",
  "3ds": "подтверждения",
  captcha: "капчи",
  password: "входа",
  address: "адреса",
  payment: "оплаты",
  info: "ответа",
};

async function deliverViaEve(opts: {
  eveUrl: string;
  secret: string;
  tenantPhone: string;
  text: string;
}): Promise<boolean> {
  const res = await fetch(`${opts.eveUrl}/internal/deliver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: opts.secret,
      tenantPhone: opts.tenantPhone,
      text: opts.text,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return res.ok;
}

const startResult = v.object({
  workflowId: v.string(),
  reused: v.boolean(),
});

const cancelRunResult = v.object({
  cancelled: v.boolean(),
  stopped: v.boolean(),
});

/** Best-effort stop of a Cloud run + its browser session. Never throws. */
export const cancelRunAction = internalAction({
  args: {
    runId: v.string(),
    sessionId: v.optional(v.string()),
  },
  returns: cancelRunResult,
  handler: async (_ctx, { runId, sessionId }): Promise<Infer<typeof cancelRunResult>> => {
    const cancelled = await cancelRun(runId);
    const stopped = sessionId ? await stopBrowserForSession(sessionId) : false;
    return { cancelled, stopped };
  },
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
    if (decision === "sleep") {
      await step.sleep(followSleepMs(i), { name: `wait-${i}` });
      continue;
    }
    let phase: WakeupPhase;
    if (decision === "giveup") {
      phase = "giveup";
      await stopGivenUpRun(step, args, `-${i}`);
    } else if (needsHuman(poll.need as CloudNeed | undefined)) {
      phase = "need";
    } else if (["failed", "cancelled"].includes(poll.status.trim().toLowerCase())) {
      phase = "failed";
    } else {
      phase = "done";
    }
    await step.runAction(
      internal.browserFollow.wakeupAgent,
      {
        tenantPhone: args.tenantPhone,
        task: args.task,
        runId: args.runId,
        sessionId: args.sessionId,
        phase,
      },
      { retry: wakeupStepRetry, name: "wakeup" },
    );
    return { outcome: decision === "giveup" ? "timeout" : "done" };
  }
  await stopGivenUpRun(step, args, "-cap");
  await step.runAction(
    internal.browserFollow.wakeupAgent,
    {
      tenantPhone: args.tenantPhone,
      task: args.task,
      runId: args.runId,
      sessionId: args.sessionId,
      phase: "giveup",
    },
    { retry: wakeupStepRetry, name: "wakeup-giveup" },
  );
  return { outcome: "timeout" };
});

/**
 * Give-up must stop the Cloud run, not just stop watching it — otherwise it
 * keeps billing and a later, unrelated errand can silently inherit its stale
 * result via nextBrowserAction's active-status branch.
 */
async function stopGivenUpRun(
  step: WorkflowCtx,
  args: { tenantPhone: string; runId: string; sessionId?: string },
  nameSuffix: string,
): Promise<void> {
  await step.runAction(
    internal.browserFollow.cancelRunAction,
    { runId: args.runId, sessionId: args.sessionId },
    { retry: true, name: `cancel${nameSuffix}` },
  );
  await step.runMutation(
    internal.tenants.patchBrowserInternal,
    {
      phoneE164: args.tenantPhone,
      runId: args.runId,
      browserStatus: STALLED_STATUS,
    },
    { name: `stall${nameSuffix}` },
  );
}

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
    const tenant = await findTenantByPhone(ctx, args.tenantPhone);
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
          // The old workflow's future steps are already guarded by
          // sameBrowserRun, so a leftover one running stale is strictly
          // better than the new run getting no follow-through at all.
          console.error("browser follow cancel failed", err);
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
    const tenant = await findTenantByPhone(ctx, tenantPhone);
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
  need: v.optional(v.string()),
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
    if (!tenant || !sameBrowserRun(tenant.browserRunId, args.runId)) {
      return { status: tenant?.browserStatus ?? "unknown", now: Date.now(), stale: true };
    }
    const cheap = await pollStatus(args.runId, args.sessionId);
    const loginWait = isLoginWaitTask(tenant.browserTask);
    const targetPage = loginPageFromTask(tenant.browserTask);
    const needLoginHydrate =
      loginWait && !tenant.browserLoginLinkSentAt;
    const run =
      !needLoginHydrate && (cheap.liveUrl || cheap.result)
        ? cheap
        : await hydrate(
            args.runId,
            cheap.sessionId ?? args.sessionId,
            targetPage,
          );
    const status = persistableStatus(run.status);
    if (status === undefined) {
      // hydrate's guarded-failure placeholder: a transient miss, never a
      // real status. Writing it would blank the tenant's known status and
      // make nextBrowserAction see neither active nor done → duplicate run.
      return {
        status: tenant.browserStatus ?? UNKNOWN_STATUS,
        now: Date.now(),
        stale: false,
        sessionId: run.sessionId ?? tenant.browserSessionId,
        liveUrl: tenant.browserLiveUrl,
      };
    }
    // A labelled/heuristic outcome only means anything once the Cloud agent
    // stopped its turn — mid-run polls (status still active) never carry a
    // usable `result`, so skip the parse and leave any earlier need in place.
    const outcome = isFollowTerminal(status) ? parseCloudOutcome(run.result, { status }) : undefined;
    const wrote = await ctx.runMutation(internal.tenants.patchBrowserInternal, {
      phoneE164: args.tenantPhone,
      runId: args.runId,
      browserStatus: status,
      browserSessionId: run.sessionId,
      browserLiveUrl: run.liveUrl ?? "",
      ...(outcome ? { browserOutcome: (run.result ?? "").slice(0, 2000) } : {}),
      ...(outcome && needsHuman(outcome.needs)
        ? {
            browserNeed: outcome.needs,
            browserNeedSince: Date.now(),
            browserNeedDetail: outcome.detail ?? "",
          }
        : {}),
    });
    if (wrote.stale) {
      return { status: run.status, now: Date.now(), stale: true };
    }
    if (outcome && !needsHuman(outcome.needs)) {
      await ctx.runMutation(internal.tenants.clearBrowserNeed, {
        phoneE164: args.tenantPhone,
        runId: args.runId,
      });
    }
    if (
      shouldSendLoginLink({
        loginWait,
        liveUrl: run.liveUrl,
        alreadySentAt: tenant.browserLoginLinkSentAt,
        landed: run.landed === true,
      })
    ) {
      const claimed = await ctx.runMutation(internal.tenants.claimBrowserLoginLink, {
        phoneE164: args.tenantPhone,
        runId: args.runId,
        liveUrl: run.liveUrl!,
      });
      const conversationId = claimed.conversationId;
      const claimedLiveUrl = claimed.liveUrl;
      if (claimed.send && conversationId && claimedLiveUrl) {
        const text = loginChatText(claimedLiveUrl, claimed.site);
        try {
          const eveUrl = process.env.EVE_URL;
          const delivered = eveUrl
            ? await deliverViaEve({
                eveUrl,
                secret: process.env.BRO_INTERNAL_SECRET ?? "",
                tenantPhone: args.tenantPhone,
                text,
              }).catch(() => false)
            : false;
          if (!delivered) {
            // No EVE_URL, or eve's own delivery route failed — cabinet.sendText
            // always reaches iMessage (it does not honor lastChannel), so it is
            // the fallback, not the default.
            await ctx.runAction(internal.cabinet.sendText, { conversationId, text });
          }
        } catch (err) {
          await ctx.runMutation(internal.tenants.releaseBrowserLoginLink, {
            phoneE164: args.tenantPhone,
            runId: args.runId,
          });
          throw err;
        }
      }
    }
    return {
      status: run.status,
      now: Date.now(),
      stale: false,
      sessionId: run.sessionId,
      liveUrl: run.liveUrl,
      result: run.result,
      need: outcome?.needs,
    };
  },
});

const wakeupPhaseArg = v.union(
  v.literal("done"),
  v.literal("need"),
  v.literal("failed"),
  v.literal("giveup"),
);

export const wakeupAgent = internalAction({
  args: {
    tenantPhone: v.string(),
    task: v.string(),
    runId: v.string(),
    sessionId: v.optional(v.string()),
    phase: wakeupPhaseArg,
  },
  returns: v.object({
    ok: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    { tenantPhone, task, runId, sessionId, phase },
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

    // The structured outcome (parseCloudOutcome, via pollRun's
    // patchBrowserInternal) already lives on the tenant, keyed to this same
    // runId — re-read it rather than threading it through the workflow args.
    const tenant = await ctx.runQuery(internal.tenants.getByPhoneInternal, {
      phoneE164: tenantPhone,
    });
    const sameRun = tenant?.browserRunId === runId;
    const need = sameRun ? tenant?.browserNeed ?? "none" : "none";
    const needDetail = sameRun ? tenant?.browserNeedDetail : undefined;
    const result = sameRun ? tenant?.browserOutcome : undefined;
    const nextTask = tenant?.browserNextTask;
    const startUrl = errandStartUrl(tenant?.browserTask);
    let site: string | undefined;
    try {
      site = startUrl ? new URL(startUrl).hostname.replace(/^www\./, "") : undefined;
    } catch {
      site = undefined;
    }
    // Best-effort fresh live URL — the one already stored can be minutes
    // stale by the time the human reads it.
    const fresh = await hydrate(runId, sessionId).catch(() => undefined);
    const liveUrl = fresh?.liveUrl ?? tenant?.browserLiveUrl;

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
          phase,
          need,
          needDetail,
          result,
          liveUrl,
          nextTask,
          site,
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
    // The errand is fully over once the human is told and nothing is left
    // waiting on them — a `need` keeps the browser up for the eventual
    // inject/confirm; `giveup` already stopped it in stopGivenUpRun.
    if ((phase === "done" || phase === "failed") && !needsHuman(need as CloudNeed) && sessionId) {
      await stopBrowserForSession(sessionId).catch((err) =>
        console.error("post-wakeup browser stop failed", err),
      );
    }
    return { ok: true };
  },
});

const stuckOnNeedRow = v.object({
  tenantPhone: v.string(),
  runId: v.string(),
  sessionId: v.optional(v.string()),
  conversationId: v.optional(v.string()),
  need: v.string(),
});

/** Tenants parked on a human input for longer than sweepWaiting's timeout. */
export const listStuckOnNeed = internalQuery({
  args: { olderThan: v.number() },
  returns: v.array(stuckOnNeedRow),
  handler: async (ctx, { olderThan }) => {
    const rows = await ctx.db
      .query("tenants")
      .withIndex("by_browserNeed", (q) => q.gt("browserNeed", ""))
      .collect();
    const out: Infer<typeof stuckOnNeedRow>[] = [];
    for (const t of rows) {
      if (!t.browserNeed || t.browserNeed === "none") continue;
      if (!t.phoneE164 || !t.browserRunId) continue;
      if ((t.browserNeedSince ?? 0) >= olderThan) continue;
      out.push({
        tenantPhone: t.phoneE164,
        runId: t.browserRunId,
        sessionId: t.browserSessionId,
        conversationId: t.photonConversationId || t.inkboxConversationId,
        need: t.browserNeed,
      });
    }
    return out;
  },
});

/**
 * 10-minute sweep (convex/crons.ts): a Cloud run parked on a human input for
 * over NEED_TIMEOUT_MS gets no wakeup on its own — nothing repolls a run
 * that already went terminal. Stop it, mark stalled, clear the need, and
 * tell the human once so the ask never just evaporates.
 */
export const sweepWaiting = internalAction({
  args: {},
  returns: v.object({ swept: v.number() }),
  handler: async (ctx): Promise<{ swept: number }> => {
    const rows = await ctx.runQuery(internal.browserFollow.listStuckOnNeed, {
      olderThan: Date.now() - NEED_TIMEOUT_MS,
    });
    let swept = 0;
    for (const row of rows) {
      await ctx.runAction(internal.browserFollow.cancelRunAction, {
        runId: row.runId,
        sessionId: row.sessionId,
      });
      await ctx.runMutation(internal.tenants.patchBrowserInternal, {
        phoneE164: row.tenantPhone,
        runId: row.runId,
        browserStatus: STALLED_STATUS,
      });
      await ctx.runMutation(internal.tenants.clearBrowserNeed, {
        phoneE164: row.tenantPhone,
        runId: row.runId,
      });
      const eveUrl = process.env.EVE_URL;
      if (eveUrl) {
        const noun = NEED_NOUN[row.need] ?? "ответа";
        await deliverViaEve({
          eveUrl,
          secret: process.env.BRO_INTERNAL_SECRET ?? "",
          tenantPhone: row.tenantPhone,
          text: `Не дождался ${noun} — когда будешь готов, напиши, продолжу.`,
        }).catch((err) => console.error("sweepWaiting deliver failed", err));
      }
      swept++;
    }
    return { swept };
  },
});
