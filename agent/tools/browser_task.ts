import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  cancelBrowserFollow,
  cancelWakeup,
  countBrowserJobStart,
  listVaultItems,
  readVaultSecret,
  recordOrder,
  startBrowserFollow,
  setBrowser,
  upsertTenant,
} from "../lib/convex";
import {
  BROWSER_WAIT_MS,
  nextBrowserAction,
  shouldStartFollowThrough,
} from "../lib/browser-policy";
import { parseOrderFromResult } from "../lib/order-policy";
import { purchaseStance } from "../lib/purchase-policy";
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
import { turnLooking } from "../lib/early-deliver.ts";
import { attrsFromSession, deliverHumanRouted } from "../lib/deliver-routed";
import { groupPersonalBlock } from "../lib/group-guard";
import { tenantId } from "../lib/tenant";
import { browserGateFromResult } from "../../convex/lib/billingPolicy";
import { cardBindings, normalizePayHosts } from "../lib/browser-pay.ts";
import { parsePaymentPayload } from "../../convex/lib/vaultPayload.ts";


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
    browserLiveUrl: run.liveUrl ?? "",
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

function extraHosts(extra: Record<string, unknown>): string[] | undefined {
  const raw = extra.payHosts;
  if (!Array.isArray(raw)) return undefined;
  const hosts = raw.filter((h): h is string => typeof h === "string");
  return hosts.length > 0 ? hosts : undefined;
}

function taskLooksLikeBuy(task: string): boolean {
  const stance = purchaseStance(task);
  return stance === "buy" || stance === "watch_and_buy";
}

async function maybeRecordOrder(
  phone: string,
  run: BrowserRun,
  task: string,
  extra: Record<string, unknown>,
): Promise<void> {
  if (run.status.toLowerCase() !== "completed") return;
  if (extra.paying !== true && !taskLooksLikeBuy(task)) return;
  const row = parseOrderFromResult({
    task,
    result: run.result,
    hosts: extraHosts(extra),
    pay: extra.paying === true,
  });
  if (!row) return;
  try {
    await recordOrder(phone, row);
  } catch (err) {
    console.error("record order failed", err);
  }
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
    if (isTerminal(run.status)) {
      await maybeRecordOrder(phone, run, task, extra);
      return payload(run, extra);
    }
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
          hint: "Сайт может потребовать логин. Если пароль уже в чате — сразу вводи его в task и продолжай. Если нет — один вопрос какой пароль поставить, либо profile_setup с url страницы входа (ссылка, человек войдёт сам).",
        }),
  };
}

export default defineTool({
  description:
    "Cloud browser (WB, Ozon, bookings, appointments, taxi, forms, search). Starts or polls the current job — never a second search. reset = fresh browser. If they gave a password, put it in task and type it (login and signup). needsProfileSync without a password → ask once or profile_setup with the login URL. status=completed → paste result. Buy: pay on first call (hosts = merchant hostnames; maxRub only if they named a ceiling). Card is server-typed. needsVaultSetup → vault_setup kind=payment.",
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
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { status: "group", hint: blocked };
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
        BROWSER_WAIT_MS,
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
    const followKick = startBrowserFollow({
      tenantPhone: phone,
      runId: started.runId,
      sessionId: started.sessionId,
      task,
      startedAt,
    }).catch((err) => {
      console.error("browser follow workflow failed", err);
    });
    const turnId = ctx.session.turn?.id;
    if (conv && !turnLooking(typeof turnId === "string" ? turnId : undefined)) {
      void deliverHumanRouted({
        attrs: attrsFromSession(ctx.session),
        tenant,
        conversationId: conv,
        text: "Ищу, это может занять пару минут. Сам напишу, когда будет готово.",
      }).catch((err) => {
        console.error("browser start notify failed", err);
      });
    }
    const done = await waitForRun(
      started.runId,
      started.sessionId,
      BROWSER_WAIT_MS,
    );
    await persist(phone, done, task);
    await followKick;
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
