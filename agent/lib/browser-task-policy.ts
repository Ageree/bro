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
import { purchaseStance } from "./purchase-policy.ts";

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
 *  "готово"/result bubble, not a new instruction (item 7). */
export function isAckLike(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes("?") || t.includes("？")) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3;
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
  opts: { pay?: boolean; rawAction: "start" | "poll" | "reuse" | "busy" },
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

export function taskLooksLikeBuy(task: string): boolean {
  const stance = purchaseStance(task);
  return stance === "buy" || stance === "watch_and_buy";
}

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
