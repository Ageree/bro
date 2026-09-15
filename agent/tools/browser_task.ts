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
  findBrowserForSession,
  getProfile,
  hydrate,
  isDryRunErrand,
  isTerminal,
  queueMessage,
  resolveQueuedRun,
  startRun,
  waitForPageLanding,
  waitForRun,
  type BrowserRun,
} from "../lib/browseruse";
import { cdpTypeIntoPage } from "../lib/browser-cdp.ts";
import { cdpPageUrl } from "../../convex/lib/browserCdp.ts";
import {
  cookieDomainsCoverPage,
  loginPageUrl,
  profileSyncStatus,
} from "../../convex/lib/browserProfilePolicy.ts";
import {
  cloudInjectKindFromAttrs,
  cloudInjectTextFromAttrs,
  cloudSessionLooksLive,
  decideCloudInject,
  injectAckText,
  injectCandidate,
  injectQueueInterrupt,
  injectQueueText,
  NO_LIVE_RUN_TEXT,
} from "../../convex/lib/browserInjectPolicy.ts";
import {
  ERRAND_LANDING_WAIT_MS,
  errandStartUrl,
} from "../../convex/lib/browserStartPolicy.ts";
import { turnSpoke } from "../lib/early-deliver.ts";
import { attrsFromSession, deliverHumanRouted } from "../lib/deliver-routed";
import { conversationId, groupPersonalBlock, turnAttributes } from "../lib/group-guard";
import { tenantId } from "../lib/tenant";
import { browserGateFromResult } from "../../convex/lib/billingPolicy";
import { cardBindings, normalizePayHosts } from "../lib/browser-pay.ts";
import { parsePaymentPayload } from "../../convex/lib/vaultPayload.ts";
import { vaultPasswordLoginForPages } from "../lib/vault-login.ts";

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

async function maybeInjectChat(
  phone: string,
  tenant: Awaited<ReturnType<typeof upsertTenant>>,
  incoming: string,
  notify: {
    conv?: string;
    turnId?: string;
    attrs: ReturnType<typeof attrsFromSession>;
  },
): Promise<Record<string, unknown> | null> {
  if (!injectCandidate(incoming)) return null;
  if (!tenant.browserRunId && !tenant.browserSessionId) {
    return decideCloudInject(incoming, {}).kind === "code"
      ? { status: "no_wait", entered: false, hint: NO_LIVE_RUN_TEXT }
      : null;
  }

  let pageUrl: string | undefined;
  let result: string | undefined;
  let browserListed = false;
  let cdpUrl: string | undefined;
  let sessionId = tenant.browserSessionId;

  if (tenant.browserRunId) {
    const run = await hydrate(tenant.browserRunId, tenant.browserSessionId).catch(
      () => undefined,
    );
    if (run) {
      pageUrl = run.pageUrl;
      result = run.result;
      sessionId = run.sessionId ?? sessionId;
    }
  }

  const browser = await findBrowserForSession(sessionId).catch(() => undefined);
  if (browser?.cdpUrl) {
    browserListed = true;
    cdpUrl = browser.cdpUrl;
    pageUrl = (await cdpPageUrl(browser.cdpUrl).catch(() => undefined)) ?? pageUrl;
  }

  const attrs = {
    status: tenant.browserStatus,
    sessionId,
    runId: tenant.browserRunId,
    storedTask: tenant.browserTask,
    startedAt: tenant.browserStartedAt,
    pageUrl,
    result,
    browserListed,
  };
  const decided = decideCloudInject(incoming, attrs);
  if (!decided.kind) return null;

  const live = cloudSessionLooksLive(attrs);
  if (!live) {
    return decided.kind === "code"
      ? { status: "no_wait", entered: false, hint: NO_LIVE_RUN_TEXT }
      : null;
  }

  const conv = notify.conv;
  if (conv && !turnSpoke(notify.turnId)) {
    void deliverHumanRouted({
      attrs: notify.attrs,
      tenant,
      conversationId: conv,
      text: injectAckText(decided.kind),
    }).catch((err) => {
      console.error("inject ack failed", err);
    });
  }

  // Fast path: type a code straight into the open tab over CDP when the live
  // browser is reachable. Best-effort — the reliable path below is the queue.
  let typed = false;
  let submitted = false;
  if (decided.kind === "code" && decided.code && cdpUrl) {
    const typedIn = await cdpTypeIntoPage(cdpUrl, decided.code).catch(
      (err: unknown) => {
        console.error("cdp inject code failed", err);
        return { typed: false, submitted: false };
      },
    );
    typed = typedIn.typed;
    submitted = typedIn.submitted;
  }

  if (!sessionId) {
    return {
      status: "no_wait",
      entered: false,
      hint: NO_LIVE_RUN_TEXT,
    };
  }

  // Reliable path: queue the line into the live session. The session holds the
  // errand history and its browser, so this lands on the already-open login tab
  // instead of starting a fresh run in a blank browser.
  const queueText = injectQueueText({
    kind: decided.kind,
    humanText: incoming,
    ...(decided.code ? { code: decided.code } : {}),
    dryRun: isDryRunErrand(tenant.browserTask ?? incoming),
    alreadyTyped: decided.kind === "code" && submitted,
  });
  const queued = await queueMessage(sessionId, queueText, {
    interrupt: injectQueueInterrupt(decided.kind),
  }).catch((err: unknown) => {
    console.error("cloud queue failed", err);
    return undefined;
  });

  const codeHint =
    "код ушёл в живую Cloud-сессию (открытая вкладка). Не цитируй цифры и не проси пароль.";
  const otherHint = "уточнение ушло в живую Cloud-сессию. Не проси пароль.";
  const hint = decided.kind === "code" ? codeHint : otherHint;

  if (!queued) {
    // CDP typing may still have entered the code; report best-effort state.
    return {
      status: tenant.browserStatus ?? "running",
      entered: typed,
      injected: decided.kind,
      typed,
      submitted,
      alreadyNotified: Boolean(conv),
      hint,
    };
  }

  const resolved: { runId?: string; status?: string } = await resolveQueuedRun(
    sessionId,
    tenant.browserRunId,
    queued,
  ).catch(() => ({ runId: queued.runId ?? tenant.browserRunId }));
  const followRunId = resolved.runId ?? tenant.browserRunId;
  const startedAt = Date.now();

  if (!followRunId) {
    return {
      status: resolved.status ?? "running",
      entered: true,
      injected: decided.kind,
      typed,
      submitted,
      alreadyNotified: Boolean(conv),
      hint,
    };
  }

  const queuedRun: BrowserRun = {
    runId: followRunId,
    sessionId,
    status: resolved.status ?? "running",
  };
  await persist(phone, queuedRun, tenant.browserTask ?? incoming, {
    browserStartedAt: startedAt,
  });
  const followKick = startBrowserFollow({
    tenantPhone: phone,
    runId: followRunId,
    sessionId,
    task: tenant.browserTask ?? incoming,
    startedAt,
  }).catch((err) => {
    console.error("inject follow workflow failed", err);
  });
  const done = await waitForRun(followRunId, sessionId, BROWSER_WAIT_MS);
  await persist(phone, done, tenant.browserTask ?? incoming);
  await followKick;
  return settle(
    phone,
    done,
    tenant.browserTask ?? incoming,
    {
      injected: decided.kind,
      typed,
      submitted,
      alreadyNotified: Boolean(conv),
      hint,
    },
    { startedAt, runId: followRunId },
  );
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

function profileExtra(
  resolved: {
    profileId?: string;
    cookieDomains: string[];
    synced: boolean;
  },
  startPage?: string,
) {
  const siteReady = Boolean(
    startPage && cookieDomainsCoverPage(resolved.cookieDomains, startPage),
  );
  return {
    profileId: resolved.profileId ?? null,
    profileSynced: resolved.synced,
    cookieDomains: resolved.cookieDomains,
    ...(startPage ? { startPage, siteReady } : {}),
    ...(siteReady || resolved.synced
      ? {}
      : {
          needsProfileSync: true,
          hint: "Сайт может потребовать логин. Сразу profile_setup с url страницы входа — инструмент сам возьмёт вход из сейфа или откроет вход и пришлёт live-view ссылку. Не проси логин или пароль. Не клади пароль в чат.",
        }),
  };
}

export default defineTool({
  description:
    "Cloud browser (WB, Ozon, bookings, appointments, taxi, forms, search). Starts or polls the current job — never a second search. reset = fresh browser. Eve opens the site over CDP (taxi.yandex.ru for такси). Vault kind:login is bound as secretBindings. Cloud cookies may exist — that is not proof the tab is logged in. The Cloud agent must click Войти / Авторизоваться / passport if the page is still guest; live-view only for OTP or a missing password. If a Cloud session is live and the human sent a one-time code, «подожди», or an address/size correction for that errand, pass their exact line here — Bro types it into the live tab (CDP) and queues it into the live Cloud session so it lands on the already-open page. Unrelated chat must not be sent here. A code they already sent must be used. needsProfileSync → profile_setup only when cookies and vault are missing. Never ask for a login or password. Never put a site password in chat. status=completed → paste result. Buy: pay on first call (hosts = merchant hostnames; maxRub only if they named a ceiling). Card is server-typed. needsVaultSetup → vault_setup kind=payment.",
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
    // The human turn is stamped with the exact code/correction it carried. Use
    // that raw line for injection instead of `task`, because the model
    // sometimes re-issues the whole errand instead of passing the bare code —
    // which used to spawn a fresh session and lose the live login.
    const turnAttrs = turnAttributes(ctx);
    const injectKind = cloudInjectKindFromAttrs(turnAttrs);
    const stampedInjectText = cloudInjectTextFromAttrs(turnAttrs);
    if (!reset) {
      const turnId = ctx.session.turn?.id;
      const injectIncoming =
        injectKind && stampedInjectText ? stampedInjectText : task;
      const injected = await maybeInjectChat(phone, tenant, injectIncoming, {
        conv,
        turnId: typeof turnId === "string" ? turnId : undefined,
        attrs: attrsFromSession(ctx.session),
      });
      if (injected) return injected;
      // A stamped inject turn (code / «подожди» / correction) must never fall
      // through to a fresh browser errand when a session is on record: a new
      // session would drop the live login (and a fresh code would be requested,
      // rejecting the stale one). If it could not be injected (browser gone),
      // say so instead of starting a new one.
      if (injectKind && (tenant.browserSessionId || tenant.browserRunId)) {
        return { status: "no_wait", entered: false, hint: NO_LIVE_RUN_TEXT };
      }
    }
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

    const loginPages = [
      ...(payHosts ?? []).map((host) => `https://${host}`),
      ...(task.match(/https?:\/\/[^\s]+/g) ?? []),
    ]
      .map((raw) => loginPageUrl(raw))
      .filter((page): page is string => Boolean(page));
    const vaultLogin = await vaultPasswordLoginForPages(phone, loginPages);
    if (vaultLogin) {
      secretBindings = [...(secretBindings ?? []), ...vaultLogin.bindings];
    }

    const resolved = await resolveSyncedProfile(phone, tenant);
    const startPage = errandStartUrl(task);
    const started = await startRun(task, reset ? undefined : tenant.browserSessionId, {
      ...(resolved.profileId
        ? { profileId: resolved.profileId, profileSynced: resolved.synced }
        : {}),
      ...(payOpts ? { pay: payOpts } : {}),
      ...(vaultLogin ? { login: true } : {}),
      ...(secretBindings && secretBindings.length > 0 ? { secretBindings } : {}),
      ...(startPage ? { startPage } : {}),
    });
    const opened = startPage
      ? await waitForPageLanding(started, startPage, ERRAND_LANDING_WAIT_MS)
      : started;
    const startedAt = Date.now();
    await persist(phone, opened, task, {
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
      runId: opened.runId,
      sessionId: opened.sessionId,
      task,
      startedAt,
    }).catch((err) => {
      console.error("browser follow workflow failed", err);
    });
    const turnId = ctx.session.turn?.id;
    if (conv && !turnSpoke(typeof turnId === "string" ? turnId : undefined)) {
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
      opened.runId,
      opened.sessionId,
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
        ...profileExtra(resolved, startPage),
        ...(opened.pageUrl ? { pageUrl: opened.pageUrl } : {}),
        ...(opened.landed !== undefined ? { landed: opened.landed } : {}),
        ...(payOpts
          ? { paying: true, payAccount: payOpts.account, payHosts: payOpts.hosts }
          : {}),
      },
      { startedAt, runId: opened.runId },
    );
  },
});
