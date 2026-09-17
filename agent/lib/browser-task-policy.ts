/**
 * Pure decision helpers extracted out of `agent/tools/browser_task.ts` (A3)
 * so they can be unit-tested without pulling in the tool's network/Convex
 * dependency graph — same pattern as `browser-policy.ts`/`order-policy.ts`/
 * `purchase-policy.ts`.
 */
import {
  cookieDomainsCoverPage,
  isLoginVaultTask,
  isLoginWaitTask,
  loginPageUrl,
} from "../../convex/lib/browserProfilePolicy.ts";
import {
  cloudStartInFlight,
  injectCandidate,
  isDoneCloudStatus,
} from "../../convex/lib/browserInjectPolicy.ts";
import { isActiveStatus } from "./browser-policy.ts";

/** Pages eve should check the vault for a saved login against: the payment
 *  hosts, the site `errandStartUrl` resolved from wording alone, and any
 *  explicit URL in the task text — in that order, `startPage` included
 *  *before* the vault lookup runs (item 3/F6: a keyword-only errand like
 *  «вызови такси домой» has no URL and no `pay`, so without `startPage` the
 *  saved taxi.yandex.ru login was never even looked up). */
export function loginPagesFor(
  task: string,
  payHosts: string[] | undefined,
  startPage: string | undefined,
): string[] {
  return [
    ...(payHosts ?? []).map((host) => `https://${host}`),
    ...(startPage ? [startPage] : []),
    ...(task.match(/https?:\/\/[^\s]+/g) ?? []),
  ]
    .map((raw) => loginPageUrl(raw))
    .filter((page): page is string => Boolean(page));
}

const TASK_MARK = /^\[bro-[a-z-]+\]\s*/i;

/** First line of a stored task, mark stripped, whitespace collapsed, capped.
 *  `tenant.browserTask` for a login run is the whole multi-line
 *  `[bro-login]…`/`[bro-vault-login]…` scaffold — that must never be echoed
 *  whole into a human-facing hint (the busy hint's "сначала закончу X"). */
export function shortTask(text: string | undefined | null, max = 80): string {
  const stripped = (text ?? "").replace(TASK_MARK, "").trim();
  const firstLine = stripped.split(/\r?\n/)[0]?.trim() ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/** A short, non-question reply is a plain acknowledgement of the last
 *  "готово"/result bubble, not a new instruction (item 7).
 *
 *  `sessionLive` switches that reading off entirely. "≤3 words, no ?" also
 *  describes «на воскресенье», «на двоих», «у окна» — the exact follow-ups
 *  people send *while* an errand is running. Read as an ack, such a line was
 *  answered with "это подтверждение, не пересылай результат заново" and the
 *  detail never reached the live Cloud session. While a session is live, or a
 *  start is in flight, a short line is a detail for the errand, not applause. */
export function isAckLike(
  text: string,
  opts?: { sessionLive?: boolean },
): boolean {
  if (opts?.sessionLive === true) return false;
  const t = text.trim();
  if (!t || t.includes("?") || t.includes("？")) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3;
}

/** Is the errand a short line could belong to actually LIVE right now?
 *
 *  S14: this used to be `isActiveStatus(status) || cloudStartInFlight(...)`,
 *  and a start claim was read as liveness no matter which errand it belonged
 *  to. A genuine «спасибо» after a FINISHED errand, typed while a brand new
 *  errand was still mid-claim, was therefore not an ack — so the `reuse`
 *  branch skipped the ack short-circuit, ran persist+settle on the OLD
 *  completed run and re-sent its result as if it had just finished again.
 *  A claim only makes a short line "a detail for the running errand" while the
 *  stored run is not already done; once it is, the claim belongs to a
 *  different errand that has no result to talk about yet. */
export function ackSessionLive(
  tenant: { browserStatus?: string; browserStartingAt?: number },
  now: number = Date.now(),
): boolean {
  if (isActiveStatus(tenant.browserStatus)) return true;
  if (isDoneCloudStatus(tenant.browserStatus)) return false;
  return cloudStartInFlight({ startingAt: tenant.browserStartingAt, now });
}

/** May this line be PARKED on the tenant row while a start is in flight?
 *
 *  S4: the claim-loser path parked whatever the human typed, unfiltered, and
 *  `drainHeldSteer` later queued it verbatim into the Cloud session — so every
 *  exclusion the inject path applies (smalltalk, a question aimed at Bro, an
 *  emoji reaction, and above all `looksLikePasswordDump`) was bypassed for
 *  anything that went through the hold. A pasted «Hunter2024» was parked by
 *  one turn and typed into the live session by the next.
 *
 *  This is the text-only half of the inject decision: every kind
 *  `decideCloudInject` can return implies it, so nothing that would have been
 *  injected is dropped, and nothing it excludes can be smuggled in through the
 *  hold. Held rows outlive the turn that wrote them, so the drain re-checks
 *  the same predicate before queueing — a row written by an older build, or by
 *  a path that forgets to filter, still never reaches the session. */
export function holdableSteer(text: string): boolean {
  return injectCandidate(text);
}

/** One charge per errand (item 10). A pay-forced restart of a run that would
 *  otherwise just "reuse" its last result, or an errand starting within
 *  `CHARGE_CONTINUE_MS` of a login run for the same session, keys off that
 *  session id so the retry/continuation cannot double-charge; every other
 *  start gets a fresh, one-off key (never charged before, so uniqueness is
 *  all that matters). */
export const CHARGE_CONTINUE_MS = 30 * 60_000;

function freshChargeKey(now: number): string {
  return `${now}-${Math.random().toString(36).slice(2, 10)}`;
}

export function chargeKeyFor(
  tenant: {
    browserSessionId?: string;
    browserTask?: string;
    browserStartedAt?: number;
  },
  opts: { pay?: boolean; rawAction: "start" | "poll" | "reuse" | "busy" | "continue" },
  now: number,
): string {
  const payForcedRestart = opts.pay === true && opts.rawAction === "reuse";
  const loginContinuing =
    (isLoginWaitTask(tenant.browserTask) || isLoginVaultTask(tenant.browserTask)) &&
    typeof tenant.browserStartedAt === "number" &&
    now - tenant.browserStartedAt < CHARGE_CONTINUE_MS;
  if (tenant.browserSessionId && (payForcedRestart || loginContinuing)) {
    return tenant.browserSessionId;
  }
  return freshChargeKey(now);
}

/** Moved next to `purchaseStance` in convex/lib/purchasePolicy.ts (the
 *  order-recording gate now runs on the Convex side too, and Convex never
 *  imports from agent/). Re-exported so existing imports keep working. */
export { taskLooksLikeBuy } from "../../convex/lib/purchasePolicy.ts";

/** Pure — testable without the network calls in `resolveSyncedProfile`.
 *  `need` is the last run's `parseCloudOutcome(...).needs`; a vault login
 *  already bound to this run, or a result that stopped on something other
 *  than a missing password, both mean profile_setup has nothing useful to
 *  add (item 4). */
export function profileExtra(
  resolved: {
    profileId?: string;
    cookieDomains: string[];
    synced: boolean;
  },
  startPage?: string,
  opts?: { vaultLogin?: boolean; need?: string },
) {
  const siteReady = Boolean(
    startPage && cookieDomainsCoverPage(resolved.cookieDomains, startPage),
  );
  const suppressed =
    opts?.vaultLogin === true || (opts?.need !== undefined && opts.need !== "password");
  return {
    profileId: resolved.profileId ?? null,
    profileSynced: resolved.synced,
    cookieDomains: resolved.cookieDomains,
    ...(startPage ? { startPage, siteReady } : {}),
    ...(siteReady || resolved.synced || suppressed
      ? {}
      : {
          needsProfileSync: true,
          hint: "Сайт может потребовать логин. Сразу profile_setup с url страницы входа — инструмент сам возьмёт вход из сейфа или откроет вход и пришлёт live-view ссылку. Не проси логин или пароль. Не клади пароль в чат.",
        }),
  };
}
