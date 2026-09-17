import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  aliasBrowserCharge,
  cancelBrowserFollow,
  cancelWakeup,
  claimBrowserStart,
  clearBrowserNeed,
  countBrowserJobStart,
  getTenant,
  holdBrowserSteer,
  listVaultItems,
  readVaultSecret,
  recordOrder,
  releaseBrowserStart,
  startBrowserFollow,
  setBrowser,
  takeBrowserPendingSteer,
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
  cloudStartInFlight,
  decideCloudInject,
  injectAckText,
  injectQueueInterrupt,
  injectQueueText,
  looksLikePasswordDump,
  NO_LIVE_RUN_TEXT,
  START_CLAIM_MS,
  steerCandidate,
  type CloudInjectKind,
} from "../../convex/lib/browserInjectPolicy.ts";
import {
  ERRAND_LANDING_WAIT_MS,
  errandStartUrl,
} from "../../convex/lib/browserStartPolicy.ts";
import { parseCloudOutcome } from "../../convex/lib/browserOutcomePolicy.ts";
import { orderRowFromRun } from "../../convex/lib/orderRecordPolicy.ts";
import { markTurnSpoke, turnSpoke } from "../lib/early-deliver.ts";
import { fastAckOf } from "../lib/fast-ack.ts";
import { attrsFromSession, deliverHumanRouted } from "../lib/deliver-routed";
import { conversationId, groupPersonalBlock, turnAttributes } from "../lib/group-guard";
import { chatConversationId, tenantId } from "../lib/tenant";
import { browserGateFromResult } from "../../convex/lib/billingPolicy";
import {
  cardBindings,
  expandPayHosts,
  isAttachCardErrand,
  normalizePayHosts,
} from "../lib/browser-pay.ts";
import { parsePaymentPayload } from "../../convex/lib/vaultPayload.ts";
import { vaultPasswordLoginForPages } from "../lib/vault-login.ts";
import {
  chargeKeyFor,
  isAckLike,
  loginPagesFor,
  profileExtra,
  shortTask,
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
          : // Never let this read as "your detail was taken": the poll branch
            // sees the human's latest line but only queues it into the live
            // session when it is steerable, and `injected` in this payload is
            // the only proof that it landed.
            "Still running. Bro will message first when this finishes. Tell the human you're looking. Do not ask them to check back. Unless this payload has `injected`, nothing from their last line was added to the running job — do not say it was.",
    ...extra,
  };
}

/** Queue one human line into a live Cloud session as a steer. Returns whether
 *  it actually landed — a failed POST must never be reported as "принял".
 *  `interrupt` is false for a run that has only just started: preempting a
 *  fresh run at t+0 would cancel the very errand the detail belongs to. */
async function queueSteer(
  sessionId: string,
  text: string,
  opts: { dryRun?: boolean; interrupt?: boolean } = {},
): Promise<boolean> {
  const queued = await queueMessage(
    sessionId,
    injectQueueText({
      kind: "steer",
      humanText: text,
      ...(opts.dryRun ? { dryRun: true } : {}),
    }),
    { interrupt: opts.interrupt ?? injectQueueInterrupt("steer") },
  ).catch((err: unknown) => {
    console.error("cloud queue steer failed", err);
    return undefined;
  });
  return Boolean(queued);
}

/** Lines parked by `holdBrowserSteer` while a start was in flight, oldest
 *  first, minus one the caller is about to queue itself. */
function heldLines(held: string, skip?: string): string[] {
  const drop = skip?.trim();
  return held
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== drop)
    .slice(0, 5);
}

/** Held text is queued into the session the moment one exists. This is the
 *  second half of the start-race fix: the follow-up is late, never lost. */
async function drainHeldSteer(
  phone: string,
  sessionId: string,
  opts: { skip?: string; dryRun?: boolean; interrupt?: boolean } = {},
): Promise<number> {
  const held = await takeBrowserPendingSteer(phone).catch((err: unknown) => {
    console.error("take pending steer failed", err);
    return "";
  });
  let sent = 0;
  for (const line of heldLines(held, opts.skip)) {
    const ok = await queueSteer(sessionId, line, {
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.interrupt !== undefined ? { interrupt: opts.interrupt } : {}),
    });
    if (ok) sent += 1;
  }
  return sent;
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
  // LIVENESS FIRST. The old order asked a pure text predicate
  // (`injectCandidate`) whether the line *looked* injectable before anything
  // had checked whether a Cloud session existed at all — so «на воскресенье»
  // was vetoed by the classifier and the live session it belonged to was
  // never consulted. Now the session decides whether to queue, and the text
  // only decides which kind of message is queued.
  const startInFlight = cloudStartInFlight({ startingAt: tenant.browserStartingAt });
  if (!tenant.browserRunId && !tenant.browserSessionId && !startInFlight) {
    // Nothing open and nothing starting: only a stray one-time code deserves
    // an answer of its own, everything else is ordinary chat.
    return decideCloudInject(incoming, {}).kind === "code"
      ? { status: "no_wait", entered: false, hint: NO_LIVE_RUN_TEXT }
      : null;
  }

  let pageUrl: string | undefined;
  let result: string | undefined;
  let browserListed = false;
  let cdpUrl: string | undefined;
  let sessionId = tenant.browserSessionId;
  // Only meaningful once there is something to probe: during a start claim
  // there is no session id yet, and "probed and found nothing" would then be
  // read as a confirmed-absent browser (cloudSessionLooksLive's F1 rule).
  let probed = false;

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

  if (sessionId || tenant.browserRunId) {
    const browser = await findBrowserForSession(sessionId).catch(() => undefined);
    probed = true;
    if (browser?.cdpUrl) {
      browserListed = true;
      cdpUrl = browser.cdpUrl;
      pageUrl = (await cdpPageUrl(browser.cdpUrl).catch(() => undefined)) ?? pageUrl;
    }
  }

  const attrs = {
    status: tenant.browserStatus,
    sessionId,
    runId: tenant.browserRunId,
    // A start claim carries the errand text before `browserTask` is written —
    // without it a follow-up landing mid-start has no task to attach to and
    // `looksLikeSteer` would refuse it.
    storedTask: tenant.browserTask ?? tenant.browserStartingTask,
    startedAt: tenant.browserStartedAt,
    startingAt: tenant.browserStartingAt,
    pageUrl,
    result,
    browserListed,
    // What the parked Cloud agent is waiting on (A2's structured outcome) —
    // authoritative over the elapsed-time/CDP-probe fallbacks below it.
    need: tenant.browserNeed,
    // findBrowserForSession was awaited above whenever there was a session or
    // run to probe, so an empty/absent browser is a confirmed absence, not
    // "unknown". During a bare start claim nothing was probed at all.
    browserProbed: probed,
  };
  const decided = decideCloudInject(incoming, attrs);
  if (!decided.kind) return null;

  const live = cloudSessionLooksLive(attrs);
  if (!live && !startInFlight) {
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

  // START RACE (the «на воскресенье» incident): a start is claimed but has not
  // produced a session id yet, so there is nothing to queue into *yet*. Park
  // the line on the tenant row — the starting turn drains it into the session
  // the moment it exists. Returning here is as important as the parking
  // itself: falling through would reach `nextBrowserAction`, which reads a row
  // with no runId as "start" and would open a SECOND cloud run (second charge,
  // first browser orphaned) whose whole task is the fragment.
  if (!live || !sessionId) {
    await holdBrowserSteer(phone, incoming).catch((err: unknown) => {
      console.error("hold steer failed", err);
    });
    return {
      status: "starting",
      entered: false,
      held: true,
      injected: decided.kind,
      alreadyNotified: Boolean(conv),
      hint: "поручение ещё открывается — я записал эту строку и передам её в него, как только страница откроется; не начинай второе поручение и не говори, что уже применил",
    };
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

  // (`sessionId` is non-empty here: the start-race branch above returns for
  //  every live-but-session-less case.)
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
  // Anything parked while this errand was still starting goes in first, in
  // the order the human typed it — appended, never interrupting, so it cannot
  // cancel the run it is meant for.
  await drainHeldSteer(phone, sessionId, {
    skip: incoming,
    dryRun: isDryRunErrand(tenant.browserTask ?? incoming),
    interrupt: false,
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

/** The status/paying/attach-card/«НУЖНО» gate and the parse both live in
 *  `orderRowFromRun` (convex/lib/orderRecordPolicy.ts) — the Convex
 *  follow-through records a background completion through the very same
 *  function, so the two paths cannot disagree about what counts as an order.
 *  `api.orders.record` upserts on (tenantId, merchantOrderId), so a run that
 *  both paths see lands on one row. */
async function maybeRecordOrder(
  phone: string,
  run: BrowserRun,
  task: string,
  extra: Record<string, unknown>,
  tenant: { browserPaying?: boolean; browserPayHosts?: string[] },
): Promise<void> {
  const row = orderRowFromRun({
    status: run.status,
    task,
    result: run.result,
    paying: payingFor(extra, tenant),
    hosts: extraHosts(extra) ?? tenant.browserPayHosts,
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

/**
 * Host to bind the vault card to on a `payment`-need continuation where the
 * model forgot `pay` — the errand's own site (from its ORIGINAL task text,
 * before the human's continuation line replaced it) first, the page the
 * live browser is actually sitting on if that fails. Never a guess: an
 * empty result means the tool cannot safely bind a card at all.
 */
async function continuationPayHosts(
  storedTask: string | undefined,
  sessionId: string,
): Promise<string[]> {
  const startPage = errandStartUrl(storedTask);
  if (startPage) {
    const hosts = expandPayHosts([startPage]);
    if (hosts.length > 0) return hosts;
  }
  const browser = await findBrowserForSession(sessionId).catch(() => undefined);
  if (!browser?.cdpUrl) return [];
  const pageUrl = await cdpPageUrl(browser.cdpUrl).catch(() => undefined);
  return pageUrl ? expandPayHosts([pageUrl]) : [];
}

export default defineTool({
  description:
    'One browser job per person: start or poll, never a second search while one runs. The site opens itself; the job logs in on its own (vault login, cookies, or Войти/passport) — never ask for a login or password, never put one in chat. busy = another job runs: say "сначала закончу X, потом сделаю Y"; do not call profile_setup. reset:true cancels the job and starts fresh. Live page + human\'s last line is a code, "подожди", an address/size correction, or "подтвердил"/"готово"/"вошёл" → pass their exact line, it gets typed/queued into the open page; never resend the old task. status:"completed" + result → report it. Buying or «привяжи карту»: pay on the first call (hosts = the site\'s hostnames, Bro widens them to the real card-form domains; maxRub only if named). needsVaultSetup → vault_setup kind=payment. needsProfileSync → profile_setup, only if no vault login was used and nothing runs.',
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
    // «привяжи карту» / «добавь способ оплаты»: an errand about the card
    // itself, with no purchase at the end. It needs the same vault card and
    // the same run-scoped bindings a paid errand gets.
    const attachCard = isAttachCardErrand(task);
    let tenant = await upsertTenant(phone);
    const conv = conversationId(ctx, chatConversationId(tenant));
    // The human turn is stamped with the exact code/correction it carried. Use
    // that raw line for injection instead of `task`, because the model
    // sometimes re-issues the whole errand instead of passing the bare code —
    // which used to spawn a fresh session and lose the live login.
    const turnAttrs = turnAttributes(ctx);
    const injectKind = cloudInjectKindFromAttrs(turnAttrs);
    const stampedInjectText = cloudInjectTextFromAttrs(turnAttrs);
    const notifyTurnId = ctx.session.turn?.id;
    const notify = {
      conv,
      turnId: typeof notifyTurnId === "string" ? notifyTurnId : undefined,
      attrs: attrsFromSession(ctx.session),
    };
    // The raw human line when the turn carried one, because the model
    // sometimes re-issues the whole errand instead of passing the bare line.
    const injectIncoming = injectKind && stampedInjectText ? stampedInjectText : task;
    if (!reset) {
      const injected = await maybeInjectChat(phone, tenant, injectIncoming, notify);
      if (injected) return injected;
      // A stamped HARD inject turn (code / «подожди» / correction / confirm)
      // must never fall through to a fresh browser errand when a session is on
      // record: a new session would drop the live login (a fresh code would
      // be requested, rejecting the stale one, and a confirm has nothing to
      // re-do in a fresh browser either). If it could not be injected
      // (browser gone), say so instead of starting a new one.
      //
      // `steer` is deliberately NOT in that set. Since steering is opt-out,
      // almost any line is stamped `steer`, so blocking on it would strand a
      // perfectly ordinary new errand behind a long-dead session id.
      // maybeInjectChat already returned null for it, which means no live
      // session took it — so let it start normally.
      if (
        injectKind &&
        injectKind !== "steer" &&
        (tenant.browserSessionId || tenant.browserRunId)
      ) {
        return { status: "no_wait", entered: false, hint: NO_LIVE_RUN_TEXT };
      }
    }
    // START RACE (d): the snapshot above was taken at the top of the turn, and
    // a first errand persists its runId/sessionId only after `startRun`
    // round-trips. Re-read the row right before the start decision so a
    // sibling turn's session — or its start claim — is actually visible here,
    // instead of deciding "start" against seconds-old emptiness.
    tenant = (await getTenant(phone).catch(() => null)) ?? tenant;
    const rawAction = nextBrowserAction({
      reset,
      runId: tenant.browserRunId,
      status: tenant.browserStatus,
      storedTask: tenant.browserTask,
      incomingTask: task,
      need: tenant.browserNeed,
      sessionId: tenant.browserSessionId,
    });
    // secretBindings are run-scoped, so a card errand can never just "reuse"
    // the last result — it has to start a fresh run with fresh bindings.
    const preAction =
      (pay || attachCard) && rawAction === "reuse" ? "start" : rawAction;
    // A `continue` target session can already be gone by the time the human
    // answers — Browser Use's 4h hard cap, or sweepWaiting stopping the
    // browser after 40min parked on a need. Check before committing to it:
    // if it's gone, just start fresh with the same task instead of failing.
    const action =
      preAction === "continue" &&
      !(await findBrowserForSession(tenant.browserSessionId).catch(() => undefined))
        ? "start"
        : preAction;

    if (action === "reuse" && tenant.browserRunId) {
      const run = await hydrate(tenant.browserRunId, tenant.browserSessionId);
      // A short, non-question follow-up on the just-finished errand ("готово",
      // "спасибо") is an acknowledgement, not a request to resend the result
      // (item 7) — do not re-run maybeRecordOrder/settle for it either.
      // But «на воскресенье» is also two words: while the errand is actually
      // running (or still starting) a short line is a detail for it, never an
      // ack, so `sessionLive` switches that reading off (e).
      const ackSessionLive =
        isActiveStatus(tenant.browserStatus) ||
        cloudStartInFlight({ startingAt: tenant.browserStartingAt });
      if (
        isAckLike(task, { sessionLive: ackSessionLive }) &&
        !looksLikeNewJob(task, tenant.browserTask ?? undefined)
      ) {
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
      // (f) A poll must not swallow the line the human just sent. `busy` keeps
      // its text in `browserNextTask`; `poll` used to be the one branch that
      // dropped it entirely, while telling the model to reassure the human —
      // which is how a detail could look accepted and be nowhere. If the line
      // carries anything for the open errand, queue it into the live session
      // now; if it is a plain «ну что там?», nothing is queued and the hint
      // says so rather than implying it was taken.
      // The human's OWN line, not whatever the model retyped: on a poll the
      // model often re-issues the old errand text, and that is not a steer.
      const steered =
        tenant.browserSessionId && steerCandidate(injectIncoming)
          ? await queueSteer(tenant.browserSessionId, injectIncoming, {
              dryRun: isDryRunErrand(tenant.browserTask ?? task),
            })
          : false;
      if (steered && tenant.browserSessionId) {
        await drainHeldSteer(phone, tenant.browserSessionId, {
          skip: injectIncoming,
          dryRun: isDryRunErrand(tenant.browserTask ?? task),
          interrupt: false,
        });
      }
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
          : steered
            ? {
                polled: true,
                injected: "steer" satisfies CloudInjectKind,
                hint: "уточнение ушло в открытую страницу (живая сессия). Скажи одной строкой, что принял, и что напишешь как будет готово.",
              }
            : { polled: true },
        { startedAt: tenant.browserStartedAt, runId: tenant.browserRunId },
        tenant,
      );
    }

    if (action === "continue" && tenant.browserRunId && tenant.browserSessionId) {
      const sessionId = tenant.browserSessionId;
      // Continuation of the SAME errand, in the SAME Cloud session: never
      // cancelRun/stopBrowserForSession (that is exactly the taxi incident —
      // tearing down the live browser and starting a fresh one re-drove the
      // whole route) and never a new billed job (aliasBrowserCharge already
      // covers this session from the original start, same reasoning as the
      // inject/resume path in maybeInjectChat, which also never calls
      // countBrowserJobStart).
      const contAttachCard = isAttachCardErrand(tenant.browserTask ?? task);
      let contPayHosts: string[] | undefined;
      let contPayHostsBase: string[] | undefined;
      if (pay) {
        contPayHostsBase = normalizePayHosts(pay.hosts);
        if (contPayHostsBase.length === 0) {
          return {
            status: "invalid",
            hint: "pay.hosts must contain at least one valid hostname",
          };
        }
        contPayHosts = expandPayHosts(pay.hosts);
      } else if (tenant.browserNeed === "payment" || contAttachCard) {
        // The model may just relay the human's own words ("оплати картой из
        // сейфа") without `pay` — bind the vault card anyway, as if `pay`
        // had been given with the errand's own site as the host. An
        // attach-card errand resumes the same way: the card is still what the
        // open tab is waiting for.
        const guessed = await continuationPayHosts(tenant.browserTask, sessionId);
        if (guessed.length > 0) contPayHosts = guessed;
      }

      let contPayItem: { handle: string; account: string } | undefined;
      if (contPayHosts && contPayHosts.length > 0) {
        const items = (await listVaultItems(phone)).filter(
          (i) => i.kind === "payment" && i.available,
        );
        contPayItem = pay?.vaultHandle
          ? items.find((i) => i.handle === pay.vaultHandle)
          : items[0];
        if (!contPayItem) {
          return {
            status: "needs_vault",
            needsVaultSetup: "payment",
            hint: "У человека нет сохранённой карты. Вызови vault_setup с kind=payment и пришли ссылку.",
          };
        }
      }

      let contPayOpts:
        | {
            hosts: string[];
            holder: string;
            account: string;
            maxRub?: number;
            attachCard?: boolean;
          }
        | undefined;
      let contSecretBindings: ReturnType<typeof cardBindings> | undefined;
      if (contPayHosts && contPayItem) {
        const secretRecord = await readVaultSecret(phone, contPayItem.handle);
        const card = secretRecord ? parsePaymentPayload(secretRecord.secret) : undefined;
        if (!card) throw new Error("карта в сейфе заполнена не полностью");
        contSecretBindings = cardBindings(card, contPayHosts);
        contPayOpts = {
          hosts: contPayHosts,
          holder: card.cardholderName,
          account: contPayItem.account,
          ...(pay?.maxRub !== undefined ? { maxRub: pay.maxRub } : {}),
          ...(contAttachCard ? { attachCard: true } : {}),
        };
      }

      const startPage = errandStartUrl(tenant.browserTask ?? task);
      const loginPages = loginPagesFor(task, contPayHostsBase, startPage);
      const vaultLogin = await vaultPasswordLoginForPages(phone, loginPages);
      if (vaultLogin) {
        contSecretBindings = [...(contSecretBindings ?? []), ...vaultLogin.bindings];
      }

      const resolved = await resolveSyncedProfile(phone, tenant);
      // No cancelRun/stopBrowserForSession, no waitForPageLanding/CDP
      // navigation to errandStartUrl — the point of `continue` is that the
      // open tab is left exactly where the previous step landed it.
      // The findBrowserForSession check above (in `action`) already caught
      // the common case of a session that is simply gone, but the session
      // can still vanish in the gap between that check and this call
      // (Browser Use's 4h hard cap / sweepWaiting's 40min stop) — a
      // fallbackToStart here must not fail the whole errand, it must fall
      // through to the ordinary fresh-start path below with the original
      // `task`, exactly as a plain "start" would.
      let started: BrowserRun | undefined;
      let fallbackToStart = false;
      try {
        started = await startRun(task, sessionId, {
          ...(resolved.profileId
            ? { profileId: resolved.profileId, profileSynced: resolved.synced }
            : {}),
          ...(contPayOpts ? { pay: contPayOpts } : {}),
          ...(vaultLogin ? { login: true } : {}),
          ...(contSecretBindings && contSecretBindings.length > 0
            ? { secretBindings: contSecretBindings }
            : {}),
          continuation: true,
          // Facts on the continuation too, not only on the first run. A
          // continuation is a NEW run built from a new task in the same tab,
          // so without this the errand loses the address and the memories
          // exactly when it needs them most — resuming into a checkout after
          // a login. It costs a few Convex reads on a path that is already
          // doing network work, and they are loaded in parallel and
          // individually caught, so a slow read degrades the context, never
          // the run.
          phone,
        });
      } catch (err) {
        console.error("continue: session gone, starting fresh", err);
        fallbackToStart = true;
      }

      if (started && !fallbackToStart) {
        const startedAt = Date.now();
        // The stored `browserTask` is the ORIGINAL errand (with its start
        // URL etc.) — the continuation text (`task`) only makes sense as
        // the Cloud run's own instruction, never as what later
        // errandStartUrl/progress-note/wakeup lookups key off (same
        // reasoning as `maybeInjectChat`'s `tenant.browserTask ?? incoming`).
        const errand = tenant.browserTask ?? task;
        await persist(phone, started, errand, {
          browserStartedAt: startedAt,
          browserPaying: Boolean(contPayOpts),
          browserPayHosts: contPayOpts?.hosts ?? [],
        });
        // The need this continuation resolves (payment/address/info/...) is
        // now acted on — clear it so a stale browserNeed never lingers.
        await clearBrowserNeed(phone, tenant.browserRunId).catch((err) => {
          console.error("clear browser need failed", err);
        });
        const followKick = startBrowserFollow({
          tenantPhone: phone,
          runId: started.runId,
          sessionId: started.sessionId,
          task: errand,
          startedAt,
        }).catch((err) => {
          console.error("browser follow workflow failed", err);
        });
        const done = await waitForRun(started.runId, started.sessionId, BROWSER_WAIT_MS);
        await persist(phone, done, errand);
        await followKick;
        return settle(
          phone,
          done,
          errand,
          {
            continued: true,
            ...(contPayOpts
              ? { paying: true, payAccount: contPayOpts.account, payHosts: contPayOpts.hosts }
              : {}),
          },
          { startedAt, runId: started.runId },
          { browserPaying: Boolean(contPayOpts), browserPayHosts: contPayOpts?.hosts },
        );
      }
      // fallbackToStart: fall through to the ordinary fresh-start path below.
    }

    // ONE start at a time, claimed BEFORE `startRun` round-trips (d). The
    // claim is a single Convex transaction, so of two turns racing to start an
    // errand exactly one wins. The loser is the follow-up that used to open a
    // second cloud run with only its fragment as the task, charge a second
    // job and orphan the first browser — it now parks its line instead, and
    // the winner queues it into the session as soon as there is one.
    if (reset) {
      // An explicit reset outranks a start in flight: it is the human saying
      // "drop that and begin again", so it takes the claim rather than being
      // parked behind it.
      await releaseBrowserStart(phone).catch(() => {});
    }
    const claim = await claimBrowserStart(phone, task, Date.now(), START_CLAIM_MS).catch(
      (err: unknown) => {
        // A claim we could not take is not a reason to refuse the errand —
        // degrade to the old (racy) behaviour rather than dropping the job.
        console.error("browser start claim failed", err);
        return { claimed: true as const };
      },
    );
    if (!claim.claimed) {
      // Re-read: the sibling start may have finished in the meantime, in which
      // case there is a live session to queue straight into.
      const now = (await getTenant(phone).catch(() => null)) ?? tenant;
      const injected = await maybeInjectChat(phone, now, injectIncoming, notify);
      if (injected) return injected;
      await holdBrowserSteer(phone, injectIncoming).catch((err: unknown) => {
        console.error("hold steer failed", err);
      });
      return {
        status: "starting",
        entered: false,
        held: true,
        activeTask: claim.startingTask ?? tenant.browserTask,
        hint: "это же поручение уже открывается в другом окне — я записал эту строку и передам её туда; не начинай второе поручение",
      };
    }

    // Cheap part before the billing gate: a missing card must not burn quota.
    // An attach-card ask used to start a run with no bindings at all and stall
    // on the card form, because the chat model only sends `pay` for purchases.
    // Bind it from the errand's own site instead, as if `pay` had been given.
    let payHosts: string[] | undefined;
    // The hosts the CALLER named, un-widened — what a saved vault login is
    // looked up against. The widened set below is only for card bindings.
    let payHostsBase: string[] | undefined;
    let payItem: { handle: string; account: string } | undefined;
    if (pay || attachCard) {
      const attachPage = pay ? undefined : errandStartUrl(task);
      const rawHosts = pay
        ? pay.hosts
        : [
            ...(task.match(/https?:\/\/[^\s]+/g) ?? []),
            ...(attachPage ? [attachPage] : []),
          ];
      payHostsBase = normalizePayHosts(rawHosts);
      if (pay && payHostsBase.length === 0) {
        // Same reasoning as every other early return past the claim: no run
        // will come of it, so the claim must not outlive the turn.
        await releaseBrowserStart(phone).catch(() => {});
        return {
          status: "invalid",
          hint: "pay.hosts must contain at least one valid hostname",
        };
      }
      // A payment form almost never lives on the merchant host itself — widen
      // to the registrable domain and the known processors, or the server
      // refuses to type the card where the field actually is.
      if (payHostsBase.length > 0) payHosts = expandPayHosts(rawHosts);
      const items = (await listVaultItems(phone)).filter(
        (i) => i.kind === "payment" && i.available,
      );
      payItem = pay?.vaultHandle
        ? items.find((i) => i.handle === pay.vaultHandle)
        : items[0];
      if (!payItem) {
        // No run will come of this claim — drop it, or the next errand would
        // read the tenant as "already starting" for the whole START_CLAIM_MS.
        await releaseBrowserStart(phone).catch(() => {});
        return {
          status: "needs_vault",
          needsVaultSetup: "payment",
          hint: "У человека нет сохранённой карты. Вызови vault_setup с kind=payment и пришли ссылку.",
        };
      }
    }

    const chargeKey = chargeKeyFor(
      { browserSessionId: tenant.browserSessionId, browserTask: tenant.browserTask, browserStartedAt: tenant.browserStartedAt },
      { pay: Boolean(pay) || attachCard, rawAction },
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
      await releaseBrowserStart(phone).catch(() => {});
      return {
        status: "limit",
        hint: "скажи человеку, что лимит браузер-задач на месяц исчерпан, предложи оплату",
      };
    }

    // The card is decrypted only once a run is actually going to start.
    let payOpts:
      | {
          hosts: string[];
          holder: string;
          account: string;
          maxRub?: number;
          attachCard?: boolean;
        }
      | undefined;
    let secretBindings: ReturnType<typeof cardBindings> | undefined;
    if (payHosts && payItem) {
      const secretRecord = await readVaultSecret(phone, payItem.handle);
      const card = secretRecord ? parsePaymentPayload(secretRecord.secret) : undefined;
      if (!card) throw new Error("карта в сейфе заполнена не полностью");
      secretBindings = cardBindings(card, payHosts);
      payOpts = {
        hosts: payHosts,
        holder: card.cardholderName,
        account: payItem.account,
        ...(pay?.maxRub !== undefined ? { maxRub: pay.maxRub } : {}),
        ...(attachCard ? { attachCard: true } : {}),
      };
    }

    // startPage (errandStartUrl) is computed BEFORE the vault-login lookup and
    // fed into it (item 3/F6): a keyword-only errand like «вызови такси
    // домой» has no `pay` and no explicit URL, so without it the saved
    // taxi.yandex.ru login is never looked up at all.
    const startPage = errandStartUrl(task);
    const loginPages = loginPagesFor(task, payHostsBase, startPage);
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
      // The run carries what Bro already knows about this human — vault
      // address and contact, curated memories, their timezone and today's
      // date, their name — instead of aborting with «НУЖНО: address» for a
      // street that was in the vault all along. `stampedInjectText` is the
      // human's OWN sentence when the turn carried one; `task` is only
      // whatever the model retyped, and «на воскресенье» only resolves to a
      // date if the run is told what today is.
      phone,
      ...(stampedInjectText && stampedInjectText !== task
        ? { humanText: stampedInjectText }
        : {}),
    }).catch(async (err: unknown) => {
      // The claim promised a run that will never exist: release it so the
      // person can simply ask again instead of being told "уже открывается"
      // for the next two minutes.
      await releaseBrowserStart(phone).catch(() => {});
      throw err;
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
    // The whole point of the claim: anything the human typed while this start
    // was in flight («на воскресенье», one second after «хочу забронировать
    // ресторан») was parked on the tenant row, and the session now exists. It
    // is appended, never `interrupt`ed — preempting the run at t+0 would
    // cancel the very errand the detail belongs to. Late, never lost.
    if (opened.sessionId) {
      await drainHeldSteer(phone, opened.sessionId, {
        skip: task,
        dryRun: isDryRunErrand(task),
        interrupt: false,
      });
    }
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
