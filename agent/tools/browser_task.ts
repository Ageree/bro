import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  cancelBrowserFollow,
  cancelWakeup,
  countBrowserJobStart,
  startBrowserFollow,
  setBrowser,
  upsertTenant,
} from "../lib/convex";
import {
  nextBrowserAction,
  shouldStartFollowThrough,
} from "../lib/browser-policy";
import {
  FOLLOW_RETRY_HINT,
} from "../../convex/lib/browserFollowPolicy.ts";
import {
  createProfile,
  hydrate,
  isTerminal,
  startRun,
  waitForRun,
  type BrowserRun,
} from "../lib/browseruse";
import { sendBlueIMessage } from "../lib/inkbox";
import { tenantId } from "../lib/tenant";
import { browserGateFromResult } from "../../convex/lib/billingPolicy";

const WAIT_MS = 12_000;

function conversationId(ctx: { session: { auth: { current?: { attributes?: Record<string, unknown> }; initiator?: { attributes?: Record<string, unknown> } } } }, fallback?: string): string | undefined {
  const attrs =
    ctx.session.auth.current?.attributes ??
    ctx.session.auth.initiator?.attributes;
  const fromAuth = attrs?.conversationId;
  if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;
  return fallback;
}

async function persist(
  phone: string,
  run: BrowserRun,
  task: string,
  extra?: { browserStartedAt?: number; browserProfileId?: string },
): Promise<void> {
  await setBrowser(phone, {
    browserRunId: run.runId,
    browserTask: task,
    browserStatus: run.status,
    ...(run.sessionId ? { browserSessionId: run.sessionId } : {}),
    ...(run.liveUrl ? { browserLiveUrl: run.liveUrl } : {}),
    ...(extra ?? {}),
  });
}

function payload(run: BrowserRun, extra?: Record<string, unknown>) {
  return {
    status: run.status,
    runId: run.runId,
    sessionId: run.sessionId,
    liveUrl: run.liveUrl,
    result: run.result ?? null,
    hint:
      run.status.toLowerCase() === "completed"
        ? "Send these results to the human now. Do not start another search."
        : isTerminal(run.status)
          ? "Job ended. Tell the human."
          : "Still running. Bro will message first when this finishes. Tell the human you're looking. Do not ask them to check back.",
    ...extra,
  };
}

async function settle(
  phone: string,
  run: BrowserRun,
  task: string,
  extra: Record<string, unknown>,
  opts: { startedAt?: number; runId?: string | null },
) {
  const now = Date.now();
  if (
    isTerminal(run.status) ||
    (opts.runId === run.runId &&
      !shouldStartFollowThrough({
        status: run.status,
        startedAt: opts.startedAt,
        now,
      }))
  ) {
    await cancelWakeup(phone, { kind: "browser_poll" }).catch(() => {});
    await cancelBrowserFollow(phone, run.runId).catch(() => {});
    if (isTerminal(run.status)) return payload(run, extra);
    return payload(run, {
      ...extra,
      hint: "джоб висит слишком долго, скажи человеку и предложи reset",
    });
  }
  const follow = await startBrowserFollow({
    tenantPhone: phone,
    runId: run.runId,
    sessionId: run.sessionId,
    task,
    startedAt: opts.startedAt ?? now,
  }).catch((err) => {
    console.error("browser follow workflow failed", err);
    return { error: "retry_later" };
  });
  if ("error" in follow && follow.error) {
    return payload(run, {
      ...extra,
      followUp: "retry",
      hint: FOLLOW_RETRY_HINT,
    });
  }
  return payload(run, extra);
}

export default defineTool({
  description:
    "Cloud browser job for any web errand — shopping (WB, Ozon), restaurant/table booking, doctor and service appointments, taxi/delivery orders via web, form filling, searching and comparing. Starts a job or polls the current one. Never starts a second search while one is running. Do not pass reset unless the human wants a fresh browser. Send result text to iMessage when status is completed.",
  inputSchema: z.object({
    task: z.string().min(1).max(4000),
    reset: z.boolean().optional(),
  }),
  async execute({ task, reset }, ctx) {
    const phone = tenantId(ctx);
    const tenant = await upsertTenant(phone);
    const conv = conversationId(ctx, tenant.inkboxConversationId);
    const action = nextBrowserAction({
      reset,
      runId: tenant.browserRunId,
      status: tenant.browserStatus,
      storedTask: tenant.browserTask,
      incomingTask: task,
    });

    if (action === "reuse" && tenant.browserRunId) {
      const run = await hydrate(tenant.browserRunId, tenant.browserSessionId);
      await persist(phone, run, tenant.browserTask ?? task);
      return settle(phone, run, tenant.browserTask ?? task, { reused: true }, {
        startedAt: tenant.browserStartedAt,
        runId: tenant.browserRunId,
      });
    }

    if (action === "poll" && tenant.browserRunId) {
      const run = await waitForRun(
        tenant.browserRunId,
        tenant.browserSessionId,
        WAIT_MS,
      );
      await persist(phone, run, tenant.browserTask ?? task);
      return settle(
        phone,
        run,
        tenant.browserTask ?? task,
        { polled: true },
        { startedAt: tenant.browserStartedAt, runId: tenant.browserRunId },
      );
    }

    let allowed = false;
    try {
      allowed = browserGateFromResult(await countBrowserJobStart(phone), undefined)
        .allowed;
    } catch (err) {
      console.error("billing browser count failed", err);
      allowed = browserGateFromResult(undefined, err).allowed;
    }
    if (!allowed) {
      return {
        status: "limit",
        hint: "скажи человеку, что лимит браузер-задач на месяц исчерпан, предложи оплату",
      };
    }

    let profileId = tenant.browserProfileId;
    if (!profileId) {
      try {
        profileId = await createProfile(phone);
      } catch (err) {
        console.error("browser profile create failed", err);
      }
    }
    const started = await startRun(
      task,
      reset ? undefined : tenant.browserSessionId,
      profileId ? { profileId } : undefined,
    );
    const startedAt = Date.now();
    await persist(phone, started, task, {
      browserStartedAt: startedAt,
      ...(profileId && !tenant.browserProfileId
        ? { browserProfileId: profileId }
        : {}),
    });
    if (conv) {
      try {
        await sendBlueIMessage({
          conversationId: conv,
          text: "Ищу, это может занять пару минут. Сам напишу, когда будет готово.",
          handle: tenant.inkboxHandle,
        });
      } catch (err) {
        console.error("browser start notify failed", err);
      }
    }
    const done = await waitForRun(started.runId, started.sessionId, WAIT_MS);
    await persist(phone, done, task);
    return settle(
      phone,
      done,
      task,
      { started: true, alreadyNotified: Boolean(conv) },
      { startedAt, runId: started.runId },
    );
  },
});
