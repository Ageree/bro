import { v, type Infer } from "convex/values";
import { type WorkflowCtx, type WorkflowId } from "@convex-dev/workflow";
import {
  internalAction,
  internalQuery,
  mutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { assertSecret } from "./secret";
import { cancelRun, hydrate, pollStatus, stopBrowserForSession } from "./lib/browseruse";
import {
  loginChatText,
  isLoginVaultTask,
  isLoginWaitTask,
  loginPageFromTask,
} from "./lib/browserProfilePolicy";
import { errandStartUrl } from "./lib/browserStartPolicy";
import { shouldSendLoginLink } from "./lib/browserLivePolicy";
import {
  decideExistingWorkflow,
  followSleepMs,
  isFollowTerminal,
  lateDeliveryKey,
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
import {
  doneNowLine,
  lateResultLine,
  lateRetryDelayMs,
  nextProgressNote,
  type ProgressKey,
} from "./lib/browserProgressPolicy";
import { isLiveBrowserPoll } from "./lib/wakeupPolicy";
import { unscheduleCron } from "./lib/wakeupCrons";
import { findTenantByPhone } from "./lib/tenantLookup";
import { chatConversationId } from "./lib/tenantConversation";
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

/** Shared human-facing delivery: eve's own route first (honors lastChannel),
 *  cabinet.sendText (always iMessage) as the fallback. Used for the login
 *  link, progress notes, and the late-result report — throws on failure so
 *  a caller can release its claim and let the next poll retry. */
async function notifyHuman(
  ctx: ActionCtx,
  opts: { tenantPhone: string; conversationId: string; text: string },
): Promise<void> {
  const eveUrl = process.env.EVE_URL;
  const delivered = eveUrl
    ? await deliverViaEve({
        eveUrl,
        secret: process.env.BRO_INTERNAL_SECRET ?? "",
        tenantPhone: opts.tenantPhone,
        text: opts.text,
      }).catch(() => false)
    : false;
  if (!delivered) {
    await ctx.runAction(internal.cabinet.sendText, {
      conversationId: opts.conversationId,
      text: opts.text,
    });
  }
}

/**
 * Send a finished run's «готово» the moment a poll sees it, instead of waking
 * a model turn (workpool hop + cold start + model TTFT) to phrase an outcome
 * that `parseCloudOutcome` has already fully resolved. Returns true when the
 * human has been told and the `done` wakeup must be skipped.
 *
 * Duplicate-proofing reuses the machinery that was already there, and adds
 * no key of its own:
 *  - `claimBrowserWakeup(runId, "done")` — the same tenant-level claim
 *    wakeupAgent takes. Winning it means nothing else can send this run's
 *    done report; `confirmBrowserWakeup` then flips it to `sent`, so a later
 *    wakeupAgent for the same run+phase short-circuits as "duplicate"
 *    without ever POSTing to eve, and no model turn happens at all.
 *  - `wakeups.takeDelivery` on `wakeupIdempotencyKey(runId, "done")` and
 *    `lateDeliveryKey(runId)` — the two durable delivery keys eve itself
 *    checks (in-memory Map + claimDurableWakeupDelivery) and lateResultNotify
 *    claims. Taken only AFTER the line actually lands, so a failed delivery
 *    can never suppress the model wakeup that has to cover for it.
 *
 * Every failure path returns false and releases the claim: the caller then
 * takes the ordinary wakeup road, because a duplicate is survivable and
 * silence is not.
 */
async function deliverDoneNow(
  ctx: ActionCtx,
  opts: { tenantPhone: string; runId: string; sessionId?: string; text: string },
): Promise<boolean> {
  const claimed = await ctx.runMutation(internal.tenants.claimBrowserWakeup, {
    phoneE164: opts.tenantPhone,
    runId: opts.runId,
    phase: "done",
  });
  if (!claimed.ok) {
    // `duplicate` — this run's done report already went out (a retried poll
    // that already spoke); say nothing again and skip the wakeup too.
    // `pending_in_flight` / `stale_run` — leave it to wakeupAgent, which owns
    // the lease-retry and stale-run discipline for those.
    return claimed.reason === "duplicate";
  }
  const conversationId = claimed.conversationId;
  if (!conversationId) {
    await ctx.runMutation(internal.tenants.releaseBrowserWakeup, {
      phoneE164: opts.tenantPhone,
      runId: opts.runId,
      phase: "done",
    });
    return false;
  }
  try {
    await notifyHuman(ctx, {
      tenantPhone: opts.tenantPhone,
      conversationId,
      text: opts.text,
    });
  } catch (err) {
    console.error("instant done deliver failed", err);
    await ctx.runMutation(internal.tenants.releaseBrowserWakeup, {
      phoneE164: opts.tenantPhone,
      runId: opts.runId,
      phase: "done",
    });
    return false;
  }
  await ctx.runMutation(internal.tenants.confirmBrowserWakeup, {
    phoneE164: opts.tenantPhone,
    runId: opts.runId,
    phase: "done",
  });
  const secret = process.env.BRO_INTERNAL_SECRET ?? "";
  for (const key of [
    wakeupIdempotencyKey(opts.runId, "done"),
    lateDeliveryKey(opts.runId),
  ]) {
    await ctx
      .runMutation(api.wakeups.takeDelivery, { secret, key })
      .catch((err: unknown) => console.error("done delivery key failed", key, err));
  }
  // Same housekeeping wakeupAgent does after a done with nothing pending:
  // the errand is over, so the Cloud browser must not keep billing.
  if (opts.sessionId) {
    await stopBrowserForSession(opts.sessionId).catch((err) =>
      console.error("post-done browser stop failed", err),
    );
  }
  return true;
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
    let poll: Infer<typeof pollReturn>;
    try {
      poll = await step.runAction(
        internal.browserFollow.pollRun,
        {
          tenantPhone: args.tenantPhone,
          runId: args.runId,
          sessionId: args.sessionId,
        },
        { retry: true, name: `poll-${i}` },
      );
    } catch (err) {
      // The step already exhausted its own retries — this is not a flaky
      // Cloud run, it's our side unable to talk to Browser Use at all (the
      // incident: a missing BROWSERUSE_API_KEY on this deployment made every
      // poll fail the same way, and the workflow just kept quietly retrying
      // for the full 20-minute budget). Stall the tenant so nextBrowserAction
      // doesn't see a run active forever, then tell the human now instead of
      // dying silently.
      console.error("browser poll step failed", err);
      await pollStepFailed(step, args, i);
      return { outcome: "done" };
    }
    if (poll.stale) {
      // Rare path: usually startFollowThrough's cancel_then_start already
      // scheduled this for the old run before this workflow was cancelled
      // outright (workflow.cancel bumps the generation number and cancels
      // the pending poll step, so this branch never runs then) — but if that
      // cancel() call itself failed, this workflow keeps polling and is the
      // only place left that can still notice a genuinely finished result.
      await step.runAction(
        internal.browserFollow.lateResultNotify,
        {
          tenantPhone: args.tenantPhone,
          runId: args.runId,
          sessionId: args.sessionId,
          task: args.task,
        },
        { retry: true, name: `late-${i}` },
      );
      return { outcome: "stale" };
    }
    const decision = nextFollowDecision({
      status: poll.status,
      startedAt: args.startedAt,
      now: poll.now,
    });
    if (decision === "sleep") {
      await step.sleep(followSleepMs(i), { name: `wait-${i}` });
      continue;
    }
    if (poll.spoke) {
      // pollRun already sent the finished run's report and flipped the
      // `done` wakeup claim to `sent` (deliverDoneNow). A model turn now
      // could only say the same thing a second time — and the claim would
      // make wakeupAgent skip the POST anyway. No new step: an in-flight
      // workflow replaying a journalled poll from before this shipped sees
      // `spoke === undefined` and takes the wakeup road as it always did.
      return { outcome: "done" };
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

/**
 * A poll step that fails outright (after its own retries) means our side
 * can't talk to Browser Use at all — not a Cloud-run problem, so unlike
 * stopGivenUpRun this never cancels the Cloud run (it may be running fine).
 * Just stop treating it as active and tell the human, the same as any other
 * terminal phase.
 */
async function pollStepFailed(
  step: WorkflowCtx,
  args: { tenantPhone: string; task: string; runId: string; sessionId?: string },
  i: number,
): Promise<void> {
  await step.runMutation(
    internal.tenants.patchBrowserInternal,
    {
      phoneE164: args.tenantPhone,
      runId: args.runId,
      browserStatus: STALLED_STATUS,
    },
    { name: `poll-fail-stall-${i}` },
  );
  await step.runAction(
    internal.browserFollow.wakeupAgent,
    {
      tenantPhone: args.tenantPhone,
      task: args.task,
      runId: args.runId,
      sessionId: args.sessionId,
      phase: "failed",
    },
    { retry: wakeupStepRetry, name: `wakeup-poll-fail-${i}` },
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
        // workflow.cancel() bumps the old workflow's generation number and
        // cancels its pending poll step outright — it never gets to run
        // pollRun again, so its own poll.stale branch in followThrough never
        // fires for this abandonment (that is the actual mechanism behind
        // the taxi-order incident: a finished run's result going unreported
        // because nothing polls it again). Schedule the late-result check
        // for the OLD run here, before cancelling, so it still gets a
        // chance once Browser Use Cloud settles.
        if (tenant.browserWorkflowRunId) {
          await ctx.scheduler.runAfter(0, internal.browserFollow.lateResultNotify, {
            tenantPhone: args.tenantPhone,
            runId: tenant.browserWorkflowRunId,
          });
        }
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
  /**
   * This poll already reported the finished run to the human (deliverDoneNow)
   * — followThrough must return without a wakeup. Optional on purpose: a
   * workflow that was already in flight when this shipped replays journalled
   * polls that predate the field, and `undefined` reads as "no, wake up" —
   * the old behaviour, no determinism violation.
   */
  spoke: v.optional(v.boolean()),
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
    // Progress notes only make sense for a human errand: a live-view login
    // wait already gets its own link, and a vault-password login run has no
    // human-facing task text at all (browserTask is the marked scaffold).
    const noProgress = loginWait || isLoginVaultTask(tenant.browserTask);
    const targetPage = loginPageFromTask(tenant.browserTask);
    const needLoginHydrate =
      loginWait && !tenant.browserLoginLinkSentAt;
    // What makes the tightened poll cadence affordable: `hydrate` costs up to
    // five upstream calls (run + session + events + /browsers + CDP), while
    // `pollStatus` is one. Once everything hydrate would add is already known
    // — a live URL is stored, the "opened" note (the only consumer of
    // pageUrl) is out, and no login link is pending — a mid-run poll needs
    // nothing but the status. A terminal status always hydrates: that is
    // where the outcome block lives.
    const openedSent = (tenant.browserProgressSent ?? []).includes("opened");
    const statusOnly =
      !needLoginHydrate &&
      cheap.status !== UNKNOWN_STATUS &&
      !isFollowTerminal(cheap.status) &&
      Boolean(tenant.browserLiveUrl) &&
      (noProgress || openedSent);
    const run = statusOnly
      ? {
          ...cheap,
          // Never blank what we already know: the tenant write below stores
          // `run.liveUrl ?? ""` and `run.sessionId` verbatim.
          sessionId: cheap.sessionId ?? tenant.browserSessionId,
          liveUrl: tenant.browserLiveUrl,
        }
      : !needLoginHydrate && (cheap.liveUrl || cheap.result)
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
    // The finished run's own report, sent from here rather than from a model
    // turn one wakeup later. Deliberately narrow — this fires only for a
    // human errand that ended in a clean, labelled «готово» with nothing
    // pending, which is exactly the case where the model has nothing left to
    // decide. need/failed/giveup, an unlabelled result, a login/vault
    // scaffold, or a queued next errand (which only the model can start) all
    // fall through to wakeupAgent unchanged.
    const queuedNext = (tenant.browserNextTask ?? "").trim();
    // Same "is this a human errand at all" rule the progress notes use: a
    // login/vault wait, or any bro-internal scaffold sitting in browserTask,
    // is not something to report as «готово» in the person's chat.
    const humanErrand =
      !noProgress && !(tenant.browserTask ?? "").trim().startsWith("[");
    const nowLine =
      outcome && humanErrand && !queuedNext
        ? doneNowLine(status, run.result, args.runId)
        : undefined;
    const spoke = nowLine
      ? await deliverDoneNow(ctx, {
          tenantPhone: args.tenantPhone,
          runId: args.runId,
          sessionId: run.sessionId ?? args.sessionId,
          text: nowLine,
        })
      : false;
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
          await notifyHuman(ctx, { tenantPhone: args.tenantPhone, conversationId, text });
        } catch (err) {
          await ctx.runMutation(internal.tenants.releaseBrowserLoginLink, {
            phoneE164: args.tenantPhone,
            runId: args.runId,
          });
          throw err;
        }
      }
    }
    // Intermediate "still working on it" notes — separate from the login
    // link above (which is its own one-shot signal) and only while the run
    // hasn't gone terminal (nextProgressNote enforces that itself).
    const startUrl = errandStartUrl(tenant.browserTask);
    let site: string | undefined;
    try {
      site = startUrl ? new URL(startUrl).hostname.replace(/^www\./, "") : undefined;
    } catch {
      site = undefined;
    }
    const note = nextProgressNote({
      status: run.status,
      startedAt: tenant.browserStartedAt ?? Date.now(),
      now: Date.now(),
      pageUrl: run.pageUrl,
      task: tenant.browserTask ?? "",
      site,
      loginWait: noProgress,
      sent: (tenant.browserProgressSent ?? []) as ProgressKey[],
      // Wording is picked from this seed: one run keeps one voice across
      // polls and retries, different runs read differently.
      seed: args.runId,
    });
    if (note) {
      const claimed = await ctx.runMutation(internal.tenants.claimBrowserProgress, {
        phoneE164: args.tenantPhone,
        runId: args.runId,
        key: note.key,
      });
      if (claimed.send && claimed.conversationId) {
        try {
          await notifyHuman(ctx, {
            tenantPhone: args.tenantPhone,
            conversationId: claimed.conversationId,
            text: note.text,
          });
        } catch (err) {
          await ctx.runMutation(internal.tenants.releaseBrowserProgress, {
            phoneE164: args.tenantPhone,
            runId: args.runId,
            key: note.key,
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
      ...(spoke ? { spoke: true } : {}),
    };
  },
});

const lateResultReturn = v.object({ delivered: v.boolean() });

/**
 * One-off report for a run that finished after nobody was polling it
 * anymore — the taxi-order incident (goal.md): a new errand / reset:true
 * abandons the previous run (browser_task.ts's cancelRun), and that old run
 * can still land a genuine, labelled done on Browser Use Cloud's side. Called
 * from two places (see startFollowThrough and followThrough below) because
 * either can be the one that actually runs for a given abandonment — see the
 * comments there.
 */
export const lateResultNotify = internalAction({
  args: {
    tenantPhone: v.string(),
    runId: v.string(),
    sessionId: v.optional(v.string()),
    // Accepted for signature parity with followThrough's own args (and the
    // caller may not have it — see startFollowThrough's replace path, where
    // the old run's task is already overwritten on the tenant by then); the
    // outcome line never quotes it.
    task: v.optional(v.string()),
    // Which retry this is (0 = the first, immediate call). The old run's
    // Cloud-side cancel may still be in flight when this first runs, so a
    // still-active run gets a few more looks (lateRetryDelayMs) before this
    // gives up for good rather than losing the result outright.
    attempt: v.optional(v.number()),
  },
  returns: lateResultReturn,
  handler: async (
    ctx,
    { tenantPhone, runId, sessionId, task, attempt },
  ): Promise<Infer<typeof lateResultReturn>> => {
    const run = await hydrate(runId, sessionId).catch((err: unknown) => {
      console.error("lateResultNotify hydrate failed", err);
      return undefined;
    });
    if (!run) return { delivered: false };
    if (!isFollowTerminal(run.status)) {
      const delay = lateRetryDelayMs(attempt ?? 0);
      if (delay !== undefined) {
        await ctx.scheduler.runAfter(delay, internal.browserFollow.lateResultNotify, {
          tenantPhone,
          runId,
          sessionId,
          task,
          attempt: (attempt ?? 0) + 1,
        });
      }
      return { delivered: false };
    }
    const line = lateResultLine(run.status, run.result, runId);
    if (!line) return { delivered: false };
    // Durable dedupe: this can be scheduled once from startFollowThrough's
    // replace path and, on the rare run where the old workflow survives to
    // see poll.stale itself, once more from followThrough — only one wins.
    // deliverDoneNow takes the same key once it has reported a run, so a
    // result already told to the human is never re-announced as "кстати".
    const claim = await ctx.runMutation(api.wakeups.takeDelivery, {
      secret: process.env.BRO_INTERNAL_SECRET ?? "",
      key: lateDeliveryKey(runId),
    });
    if (!claim.taken) return { delivered: false };
    const tenant = await ctx.runQuery(internal.tenants.getByPhoneInternal, {
      phoneE164: tenantPhone,
    });
    const conversationId = chatConversationId(tenant);
    if (!conversationId) {
      console.error("lateResultNotify: no conversation for tenant", tenantPhone);
      return { delivered: false };
    }
    try {
      await notifyHuman(ctx, { tenantPhone, conversationId, text: line });
    } catch (err) {
      console.error("lateResultNotify deliver failed", err);
      return { delivered: false };
    }
    return { delivered: true };
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
    if (!claimed.conversationId) {
      console.error("wakeupAgent: tenant has no chat conversation", {
        tenantPhone,
        runId,
        phase,
      });
      await ctx.runMutation(internal.tenants.releaseBrowserWakeup, {
        phoneE164: tenantPhone,
        runId,
        phase,
      });
      return { ok: false, reason: "no conversation" };
    }

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
    // stale by the time the human reads it. Only `need` ever puts that link
    // in front of a person (humanLineForNeed); for done/failed/giveup the run
    // is over and the round-trip bought nothing but a second of extra wait
    // before the human hears anything.
    const fresh =
      phase === "need" ? await hydrate(runId, sessionId).catch(() => undefined) : undefined;
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
        conversationId: chatConversationId(t),
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
