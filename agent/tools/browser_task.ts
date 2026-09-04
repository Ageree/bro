import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  cancelBrowserFollow,
  cancelWakeup,
  countBrowserJobStart,
  listVaultItems,
  readVaultSecret,
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
  envSyncedProfileId,
  getProfile,
  hydrate,
  isTerminal,
  startRun,
  waitForRun,
  type BrowserRun,
} from "../lib/browseruse";
import { profileSyncStatus } from "../../convex/lib/browserProfilePolicy.ts";
import { sendBlueIMessage } from "../lib/inkbox";
import { tenantId } from "../lib/tenant";
import { browserGateFromResult } from "../../convex/lib/billingPolicy";
import { cardBindings, normalizePayHosts } from "../lib/browser-pay.ts";
import { parsePaymentPayload } from "../../convex/lib/vaultPayload.ts";

const WAIT_MS = 12_000;

function conversationId(
  ctx: {
    session: {
      auth: {
        current?: { attributes?: Record<string, unknown> } | null;
        initiator?: { attributes?: Record<string, unknown> } | null;
      };
    };
  },
  fallback?: string,
): string | undefined {
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
  extra?: {
    browserStartedAt?: number;
    browserProfileId?: string;
    browserCookieDomains?: string[];
    browserProfileSyncedAt?: number;
  },
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

async function resolveSyncedProfile(
  phone: string,
  tenant: {
    browserProfileId?: string;
    browserCookieDomains?: string[];
  },
): Promise<{
  profileId?: string;
  cookieDomains: string[];
  synced: boolean;
}> {
  let profileId = tenant.browserProfileId ?? envSyncedProfileId();
  if (!profileId) {
    try {
      profileId = await createProfile(phone);
    } catch (err) {
      console.error("browser profile create failed", err);
    }
  }
  let cookieDomains = tenant.browserCookieDomains ?? [];
  if (profileId && cookieDomains.length === 0) {
    try {
      cookieDomains = (await getProfile(profileId)).cookieDomains;
    } catch (err) {
      console.error("browser profile get failed", err);
    }
  }
  return {
    ...(profileId ? { profileId } : {}),
    cookieDomains,
    synced: profileSyncStatus({ profileId, cookieDomains }) === "synced",
  };
}

function profileExtra(resolved: {
  profileId?: string;
  cookieDomains: string[];
  synced: boolean;
}) {
  return {
    profileId: resolved.profileId ?? null,
    profileSynced: resolved.synced,
    cookieDomains: resolved.cookieDomains,
    ...(resolved.synced
      ? {}
      : {
          needsProfileSync: true,
          hint: "Сайт может потребовать логин. Вызови profile_setup с url страницы входа — ссылка уйдёт человеку в чат, он войдёт сам. Пароль не проси.",
        }),
  };
}

export default defineTool({
  description:
    "Cloud browser job for any web errand — shopping (WB, Ozon), restaurant/table booking, doctor and service appointments, taxi/delivery orders via web, form filling, searching and comparing, including sites where the human already signed in via a login link. Starts a job or polls the current one. Never starts a second search while one is running. Do not pass reset unless the human wants a fresh browser. If needsProfileSync is true, call profile_setup with the site URL instead of asking for a password. Send result text to iMessage when status is completed. Pass `pay` to let the cloud browser pay with the human's saved vault card — the card is typed by the Browser Use server via bound secrets, the model never sees it. `pay.hosts` is the bare hostname(s) where the card may be typed (the merchant, plus its payment/acquiring page if you know it). Only call with `pay` after the human has confirmed the shop, item, quantity, option and total; put the confirmed total into `pay.maxRub`. If the result has needsVaultSetup, call vault_setup with kind=payment.",
  inputSchema: z.object({
    task: z.string().min(1).max(4000),
    reset: z.boolean().optional(),
    pay: z
      .object({
        hosts: z.array(z.string().min(1).max(253)).min(1).max(10),
        maxRub: z.number().positive().max(10_000_000).optional(),
        vaultHandle: z.string().min(1).max(200).optional(),
      })
      .optional(),
  }),
  async execute({ task, reset, pay }, ctx) {
    const phone = tenantId(ctx);
    const tenant = await upsertTenant(phone);
    const conv = conversationId(ctx, tenant.inkboxConversationId);
    const rawAction = nextBrowserAction({
      reset,
      runId: tenant.browserRunId,
      status: tenant.browserStatus,
      storedTask: tenant.browserTask,
      incomingTask: task,
    });
    // secretBindings are run-scoped, so a paid errand can never just "reuse"
    // the last result — it has to start a fresh run with fresh bindings.
    const action = pay && rawAction === "reuse" ? "start" : rawAction;

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
        pay
          ? {
              polled: true,
              payDeferred: true,
              hint: "Оплата не началась: предыдущий браузер-job ещё идёт. Дождись его завершения и вызови browser_task с pay ещё раз.",
            }
          : { polled: true },
        { startedAt: tenant.browserStartedAt, runId: tenant.browserRunId },
      );
    }

    // Cheap part before the billing gate: a missing card must not burn quota.
    let payHosts: string[] | undefined;
    let payItem: { handle: string; account: string } | undefined;
    if (pay) {
      payHosts = normalizePayHosts(pay.hosts);
      if (payHosts.length === 0) {
        return {
          status: "invalid",
          hint: "pay.hosts must contain at least one valid hostname",
        };
      }
      const items = (await listVaultItems(phone)).filter(
        (i) => i.kind === "payment" && i.available,
      );
      payItem = pay.vaultHandle
        ? items.find((i) => i.handle === pay.vaultHandle)
        : items[0];
      if (!payItem) {
        return {
          status: "needs_vault",
          needsVaultSetup: "payment",
          hint: "У человека нет сохранённой карты. Вызови vault_setup с kind=payment и пришли ссылку.",
        };
      }
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

    // The card is decrypted only once a run is actually going to start.
    let payOpts:
      | { hosts: string[]; holder: string; account: string; maxRub?: number }
      | undefined;
    let secretBindings: ReturnType<typeof cardBindings> | undefined;
    if (pay && payHosts && payItem) {
      const secretRecord = await readVaultSecret(phone, payItem.handle);
      const card = secretRecord ? parsePaymentPayload(secretRecord.secret) : undefined;
      if (!card) throw new Error("карта в сейфе заполнена не полностью");
      secretBindings = cardBindings(card, payHosts);
      payOpts = {
        hosts: payHosts,
        holder: card.cardholderName,
        account: payItem.account,
        ...(pay.maxRub !== undefined ? { maxRub: pay.maxRub } : {}),
      };
    }

    const resolved = await resolveSyncedProfile(phone, tenant);
    const started = await startRun(task, reset ? undefined : tenant.browserSessionId, {
      ...(resolved.profileId
        ? { profileId: resolved.profileId, profileSynced: resolved.synced }
        : {}),
      ...(payOpts ? { pay: payOpts, secretBindings } : {}),
    });
    const startedAt = Date.now();
    await persist(phone, started, task, {
      browserStartedAt: startedAt,
      ...(resolved.profileId && resolved.profileId !== tenant.browserProfileId
        ? { browserProfileId: resolved.profileId }
        : {}),
      ...(resolved.cookieDomains.length > 0
        ? {
            browserCookieDomains: resolved.cookieDomains,
            browserProfileSyncedAt: Date.now(),
          }
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
      {
        started: true,
        alreadyNotified: Boolean(conv),
        ...profileExtra(resolved),
        ...(payOpts
          ? { paying: true, payAccount: payOpts.account, payHosts: payOpts.hosts }
          : {}),
      },
      { startedAt, runId: started.runId },
    );
  },
});
