import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  aliasBrowserCharge,
  cancelBrowserFollow,
  cancelWakeup,
  clearBrowserNeed,
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
  isActiveStatus,
  looksLikeNewJob,
  nextBrowserAction,
  normalizeTask,
  shouldStartFollowThrough,
} from "../lib/browser-policy";
import { parseOrderFromResult } from "../lib/order-policy";
import {
  FOLLOW_RETRY_HINT,
  persistableStatus,
} from "../../convex/lib/browserFollowPolicy.ts";
import {
  cancelRun,
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
  stopBrowserForSession,
  waitForPageLanding,
  waitForRun,
  type BrowserRun,
} from "../lib/browseruse";
import { cdpTypeIntoPage } from "../lib/browser-cdp.ts";
import { cdpPageUrl } from "../../convex/lib/browserCdp.ts";
import {
  cookieCacheStale,
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
  looksLikePasswordDump,
  NO_LIVE_RUN_TEXT,
} from "../../convex/lib/browserInjectPolicy.ts";
import {
  ERRAND_LANDING_WAIT_MS,
  errandStartUrl,
} from "../../convex/lib/browserStartPolicy.ts";
import { parseCloudOutcome } from "../../convex/lib/browserOutcomePolicy.ts";
import { markTurnSpoke, turnSpoke } from "../lib/early-deliver.ts";
import { fastAckOf } from "../lib/fast-ack.ts";
import { attrsFromSession, deliverHumanRouted } from "../lib/deliver-routed";
import { conversationId, groupPersonalBlock, turnAttributes } from "../lib/group-guard";
import { tenantId } from "../lib/tenant";
import { browserGateFromResult } from "../../convex/lib/billingPolicy";
import { cardBindings, normalizePayHosts } from "../lib/browser-pay.ts";
import { parsePaymentPayload } from "../../convex/lib/vaultPayload.ts";
import { vaultPasswordLoginForPages } from "../lib/vault-login.ts";
import {
  chargeKeyFor,
  isAckLike,
  loginPagesFor,
  profileExtra,
  shortTask,
  taskLooksLikeBuy,
} from "../lib/browser-task-policy.ts";

async function persist(
  phone: string,
  run: BrowserRun,
  task: string,
  extra?: {
    browserStartedAt?: number;
    browserProfileId?: string;
    browserCookieDomains?: string[];
    browserProfileSyncedAt?: number;
    browserPaying?: boolean;
    browserPayHosts?: string[];
    browserNextTask?: string;
  },
): Promise<void> {
  // hydrate's guarded-failure "unknown" is a transient miss, never a real
  // status — writing it would blank out a known status/liveUrl and make
  // nextBrowserAction see neither active nor done, starting a duplicate run.
  const status = persistableStatus(run.status);
  await setBrowser(phone, {
    browserRunId: run.runId,
    browserTask: task,
    ...(status !== undefined
      ? { browserStatus: status, browserLiveUrl: run.liveUrl ?? "" }
      : {}),
    ...(run.sessionId ? { browserSessionId: run.sessionId } : {}),
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
    // What the parked Cloud agent is waiting on (A2's structured outcome) —
    // authoritative over the elapsed-time/CDP-probe fallbacks below it.
    need: tenant.browserNeed,
    // findBrowserForSession was just awaited above unconditionally on this
    // path, so an empty/absent browser is a confirmed absence, not "unknown".
    browserProbed: true,
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
  if (conv && !turnSpoke(notify.turnId) && !fastAckOf(notify.attrs)) {
    void deliverHumanRouted({
      attrs: notify.attrs,
      tenant,
      conversationId: conv,
      text: injectAckText(decided.kind),
    }).catch((err) => {
      console.error("inject ack failed", err);
    });
    if (notify.turnId) markTurnSpoke(notify.turnId, Date.now());
  }

  // Fast path: type a code straight into the open tab over CDP when the live
  // browser is reachable. Best-effort — the reliable path below is the queue.
  // `confirm` never types over CDP (nothing to type — it just checks whether
  // the already-open page advanced) and never interrupts the run either
  // (injectQueueInterrupt(kind) below).
  let typed = false;
  let submitted = false;
  let partial = false;
  if (decided.kind === "code" && decided.code && cdpUrl) {
    const typedIn = await cdpTypeIntoPage(cdpUrl, decided.code).catch(
      (err: unknown) => {
        console.error("cdp inject code failed", err);
        return { typed: false, submitted: false, partial: false };
      },
    );
    typed = typedIn.typed;
    submitted = typedIn.submitted;
    partial = typedIn.partial === true;
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
    // A `partial` CDP fill (a single maxLength=1 box swallowed only the first
    // digit) never counts as "already typed" — the queued Cloud message must
    // still carry the full code (item 17).
    alreadyTyped: decided.kind === "code" && submitted && !partial,
  });
  const queued = await queueMessage(sessionId, queueText, {
    interrupt: injectQueueInterrupt(decided.kind),
  }).catch((err: unknown) => {
    console.error("cloud queue failed", err);
    return undefined;
  });

  if (!queued) {
    // The queue call failed outright: whatever CDP best-effort typing did or
    // didn't do, the code/confirmation did NOT reliably reach the page — say
    // so rather than reporting `typed` as success.
    const what = decided.kind === "code" ? "код" : "подтверждение";
    return {
      status: browserListed ? (tenant.browserStatus ?? "running") : "no_wait",
      entered: false,
      injected: decided.kind,
      typed,
      submitted,
      alreadyNotified: Boolean(conv),
      hint: `не удалось передать ${what} в открытую страницу — скажи, что страница уже закрылась, и предложи начать заново`,
    };
  }

  // The need this run was parked on (if any) is now satisfied — clear it so
  // a stale browserNeed never lingers once the queued input has landed. The
  // resumed run usually keeps the same runId, so `setBrowser`'s own
  // new-run-id auto-clear does not fire for this case.
  if (tenant.browserRunId) {
    await clearBrowserNeed(phone, tenant.browserRunId).catch((err) => {
      console.error("clear browser need failed", err);
    });
  }

  const codeHint =
    "код ушёл в открытую страницу (живая сессия). Не цитируй цифры и не проси пароль.";
  const otherHint = "уточнение ушло в открытую страницу (живая сессия). Не проси пароль.";
  const hint = decided.kind === "code" ? codeHint : otherHint;

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
    tenant,
  );
}

function extraHosts(extra: Record<string, unknown>): string[] | undefined {
  const raw = extra.payHosts;
  if (!Array.isArray(raw)) return undefined;
  const hosts = raw.filter((h): h is string => typeof h === "string");
  return hosts.length > 0 ? hosts : undefined;
}

/** `extra.paying`/`extra.payHosts` only carry the call's own paid-start flag —
 *  every later settle() (reuse/poll/inject) has none of that, so fall back to
 *  the tenant row a fresh paid start persisted it onto (item 2). */
function payingFor(
  extra: Record<string, unknown>,
  tenant: { browserPaying?: boolean },
): boolean {
  return typeof extra.paying === "boolean" ? extra.paying : tenant.browserPaying === true;
}

async function maybeRecordOrder(
  phone: string,
  run: BrowserRun,
  task: string,
  extra: Record<string, unknown>,
  tenant: { browserPaying?: boolean; browserPayHosts?: string[] },
): Promise<void> {
  if (run.status.toLowerCase() !== "completed") return;
  const paying = payingFor(extra, tenant);
  if (!paying && !taskLooksLikeBuy(task)) return;
  // A run that stopped on a blocker (3DS, a missing card, an OTP) is not a
  // placed order yet, whatever free-text guessing over its result might say.
  if (parseCloudOutcome(run.result).needs !== "none") return;
  const row = parseOrderFromResult({
    task,
    result: run.result,
    hosts: extraHosts(extra) ?? tenant.browserPayHosts,
    pay: paying,
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
  tenant: { browserPaying?: boolean; browserPayHosts?: string[] },
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
      await maybeRecordOrder(phone, run, task, extra, tenant);
      return payload(run, extra);
    }
    return payload(run, {
      ...extra,
      hint: "это поручение идёт необычно долго — скажи человеку своими словами и, если он согласен, вызови browser_task с reset:true, чтобы начать заново",
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
    browserNeed?: string;
    browserProfileSyncedAt?: number;
  },
): Promise<{
  profileId?: string;
  cookieDomains: string[];
  synced: boolean;
}> {
  let profileId = tenant.browserProfileId ?? envSyncedProfileId(phone);
  if (!profileId) {
    try {
      profileId = await createProfile(phone);
    } catch (err) {
      console.error("browser profile create failed", err);
    }
  }
  // A run that just reported it needs a password means cached cookies do not
  // prove a login (F7) — never trust them past that point.
  let cookieDomains = tenant.browserNeed === "password" ? [] : tenant.browserCookieDomains ?? [];
  if (profileId && (cookieDomains.length === 0 || cookieCacheStale(tenant, Date.now()))) {
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

export default defineTool({
  description:
    'One browser job per person: start or poll, never a second search while one runs. The site opens itself; the job logs in on its own (vault login, cookies, or Войти/passport) — never ask for a login or password, never put one in chat. busy = another job runs: say "сначала закончу X, потом сделаю Y"; do not call profile_setup. reset:true cancels the job and starts fresh. Live page + human\'s last line is a code, "подожди", an address/size correction, or "подтвердил"/"готово"/"вошёл" → pass their exact line, it gets typed/queued into the open page; never resend the old task. status:"completed" + result → report it. Buying: pay on the first call (hosts = merchant hostnames; maxRub only if named). needsVaultSetup → vault_setup kind=payment. needsProfileSync → profile_setup, only if no vault login was used and nothing runs.',
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
    if (looksLikePasswordDump(task)) {
      return {
        status: "invalid",
        hint: "это похоже на пароль сайта, не поручение — пароль в чат не нужен",
      };
    }
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
      // A stamped inject turn (code / «подожди» / correction / confirm) must
      // never fall through to a fresh browser errand when a session is on
      // record: a new session would drop the live login (a fresh code would
      // be requested, rejecting the stale one, and a confirm has nothing to
      // re-do in a fresh browser either). If it could not be injected
      // (browser gone), say so instead of starting a new one.
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
      // A short, non-question follow-up on the just-finished errand ("готово",
      // "спасибо") is an acknowledgement, not a request to resend the result
      // (item 7) — do not re-run maybeRecordOrder/settle for it either.
      if (isAckLike(task) && !looksLikeNewJob(task, tenant.browserTask ?? undefined)) {
        return {
          status: run.status,
          reused: true,
          ack: true,
          hint: "это подтверждение, не пересылай результат заново; одна короткая строка или реакция",
        };
      }
      await persist(phone, run, tenant.browserTask ?? task);
      return settle(
        phone,
        run,
        tenant.browserTask ?? task,
        { reused: true },
        { startedAt: tenant.browserStartedAt, runId: tenant.browserRunId },
        tenant,
      );
    }

    if (action === "busy" && tenant.browserRunId) {
      const run = await waitForRun(
        tenant.browserRunId,
        tenant.browserSessionId,
        BROWSER_WAIT_MS,
      );
      await persist(phone, run, tenant.browserTask ?? task, {
        browserNextTask: task,
      });
      return {
        status: "busy",
        activeTask: tenant.browserTask,
        queuedTask: task,
        hint: `скажи одной строкой: сначала закончу ${shortTask(tenant.browserTask) || "текущее"}, потом сделаю ${shortTask(task)}. Не вызывай profile_setup.`,
      };
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
              hint: "оплата ещё не началась — сначала должно закончиться то, что уже идёт, потом вызови browser_task с pay ещё раз",
            }
          : { polled: true },
        { startedAt: tenant.browserStartedAt, runId: tenant.browserRunId },
        tenant,
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

    const chargeKey = chargeKeyFor(
      { browserSessionId: tenant.browserSessionId, browserTask: tenant.browserTask, browserStartedAt: tenant.browserStartedAt },
      { pay: Boolean(pay), rawAction },
      Date.now(),
    );
    let allowed = false;
    try {
      allowed = browserGateFromResult(
        await countBrowserJobStart(phone, { chargeKey }),
        undefined,
      ).allowed;
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

    // startPage (errandStartUrl) is computed BEFORE the vault-login lookup and
    // fed into it (item 3/F6): a keyword-only errand like «вызови такси
    // домой» has no `pay` and no explicit URL, so without it the saved
    // taxi.yandex.ru login is never looked up at all.
    const startPage = errandStartUrl(task);
    const loginPages = loginPagesFor(task, payHosts, startPage);
    const vaultLogin = await vaultPasswordLoginForPages(phone, loginPages);
    if (vaultLogin) {
      secretBindings = [...(secretBindings ?? []), ...vaultLogin.bindings];
    }

    // Fresh session per errand: never hand the old browser to a new run.
    // Cancel a still-active previous run (billing stops immediately) and stop
    // its browser session (a completed run does not close its own browser).
    if (tenant.browserRunId && isActiveStatus(tenant.browserStatus)) {
      await cancelRun(tenant.browserRunId).catch((err) =>
        console.error("browser cancel run failed", err),
      );
    }
    if (tenant.browserSessionId) {
      await stopBrowserForSession(tenant.browserSessionId).catch((err) =>
        console.error("browser stop session failed", err),
      );
    }

    const resolved = await resolveSyncedProfile(phone, tenant);
    const started = await startRun(task, undefined, {
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
    // The charge above was keyed by `chargeKey`, which for a brand new errand
    // is a fresh one-off string, not this run's session id — alias it onto
    // the session id now that it exists so a later pay-forced restart or a
    // login→errand continuation (chargeKeyFor keys those off the session id)
    // finds it already covered instead of charging a second time.
    if (opened.sessionId) {
      await aliasBrowserCharge(phone, opened.sessionId).catch((err) => {
        console.error("alias browser charge failed", err);
      });
    }
    const startedAt = Date.now();
    // This run is really starting: the queued task it may have been standing
    // in for is now underway, so clear it (item 1) — and record whether it is
    // a paid run so every later settle() (reuse/poll/inject) can still gate
    // maybeRecordOrder correctly (item 2), not just this synchronous call.
    const nextTaskDone =
      tenant.browserNextTask !== undefined &&
      normalizeTask(tenant.browserNextTask) === normalizeTask(task);
    await persist(phone, opened, task, {
      browserStartedAt: startedAt,
      browserPaying: Boolean(payOpts),
      browserPayHosts: payOpts?.hosts ?? [],
      ...(nextTaskDone ? { browserNextTask: "" } : {}),
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
    // Best-effort early kick, not the only chance to start follow-through:
    // settle() below re-derives whether this run still needs polling from
    // `done.status` alone and, in the one case where it does (not terminal,
    // not given up), calls startBrowserFollow again and surfaces a failure
    // to the model via `hint: FOLLOW_RETRY_HINT`. So a failure here is never
    // swallowed into silence for the human — only left unlogged if we only
    // caught a thrown/rejected promise and ignored a resolved `{error}`.
    const followKick = startBrowserFollow({
      tenantPhone: phone,
      runId: opened.runId,
      sessionId: opened.sessionId,
      task,
      startedAt,
    }).then(
      (result) => {
        if ("error" in result && result.error) {
          console.error("browser follow workflow failed to start", result.error);
        }
      },
      (err) => {
        console.error("browser follow workflow failed", err);
      },
    );
    const turnId = ctx.session.turn?.id;
    const tId = typeof turnId === "string" ? turnId : undefined;
    if (conv && !turnSpoke(tId) && !fastAckOf(attrsFromSession(ctx.session))) {
      void deliverHumanRouted({
        attrs: attrsFromSession(ctx.session),
        tenant,
        conversationId: conv,
        text: "ищу, сам напишу как будет готово",
      }).catch((err) => {
        console.error("browser start notify failed", err);
      });
      if (tId) markTurnSpoke(tId, Date.now());
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
        ...profileExtra(resolved, startPage, {
          vaultLogin: Boolean(vaultLogin),
          need: parseCloudOutcome(done.result).needs,
        }),
        ...(opened.pageUrl ? { pageUrl: opened.pageUrl } : {}),
        ...(opened.landed !== undefined ? { landed: opened.landed } : {}),
        ...(payOpts
          ? { paying: true, payAccount: payOpts.account, payHosts: payOpts.hosts }
          : {}),
      },
      { startedAt, runId: opened.runId },
      { browserPaying: Boolean(payOpts), browserPayHosts: payOpts?.hosts },
    );
  },
});
