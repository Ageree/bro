import { env } from "@shared/environment";
import { isPublicSuffix } from "@shared/browser/public-suffixes";
import {
  claimBrowserSignInRefresh,
  listDueBrowserSignInRefreshes,
  readBrowserSignIns,
  recordBrowserSignIn,
  recordBrowserSignInCheck,
  recordBrowserSignOut,
} from "@db/services/browser-sign-ins";
import {
  listBrowserHoldingSites,
  listWorkspacesHoldingBrowsers,
} from "@db/services/browser-runs";
import {
  browserUseBusy,
  browserUseOutOfCredits,
  createBrowserUseBrowser,
  stopBrowserUseBrowser,
} from "./client";
import { visitPageOverCdp } from "./cdp";
import type { BrowserRunNeed } from "./outcome";
import { customProxy } from "./proxy";
import {
  gosuslugiDomain,
  isGosuslugi,
  signsInWithGosuslugi,
} from "./public-services";
import { registrableDomain } from "./secrets";

/**
 * Keeping the person signed in where they signed in once.
 *
 * Every errand of a workspace runs on its one Browser Use profile, so the
 * sign-ins it earns are shared: Госуслуги signs in mos.ru and ЕМИАС too, and
 * Яндекс ID all of yandex.ru. That is also why the profile is not split per
 * site: a profile per domain would sign ЕМИАС in on its own, and Browser Use
 * caps how many profiles a project may hold. What keeps the sign-ins is
 * elsewhere: the browser is stopped cleanly once its page is not waiting for
 * the person (`completion.ts`, and the idle stop in the poller), two errands
 * never sign in to one account at once (`accountInUse`), and the sites the
 * person uses are visited every few days so their sessions stay fresh
 * (`refreshDueSignIns`).
 */

/** The bare lower-case host of a site origin or page. */
function hostOf(site: string | null | undefined) {
  const host = URL.parse(site ?? "")
    ?.hostname.toLowerCase()
    .replace(/\.$/u, "");
  return host === undefined || host === "" ? undefined : host;
}

/** The registrable domain of a host, never a shared suffix. */
function ownDomain(host: string) {
  const domain = registrableDomain(host);
  return domain === undefined || isPublicSuffix(domain) ? undefined : domain;
}

/**
 * The account a run on `site` signs in to. Госуслуги stands behind every
 * site that signs people in through it: one ESIA account and one SMS code
 * for gosuslugi.ru, mos.ru and ЕМИАС alike.
 */
function signInAccount(site: string | null | undefined) {
  const host = hostOf(site);
  if (host === undefined) return undefined;
  if (isGosuslugi(host) || signsInWithGosuslugi(host)) return gosuslugiDomain;
  return ownDomain(host);
}

/**
 * The domains whose sign-in serves an errand on `site`: its own, and
 * Госуслуги for a site that signs people in through it.
 */
function servingDomains(site: string | null | undefined) {
  const host = hostOf(site);
  if (host === undefined) return [];
  const own = ownDomain(host);
  const esia =
    isGosuslugi(host) || signsInWithGosuslugi(host) ? gosuslugiDomain : "";
  return [...new Set([own ?? "", esia])].filter((domain) => domain !== "");
}

/**
 * The account another errand of the workspace may be signing in to right
 * now, when this errand would sign in to it too. Two sign-ins at once send
 * two codes, and each cancels the other: on 25.09 three errands signed in to
 * Госуслуги together (RU d06, d07, d08), the person sent code after code, and
 * every sign-in was thrown out. The errand waits instead, and starts from the
 * profile the first one leaves — signed in.
 */
export async function accountInUse(
  workspaceId: string,
  site: string | null | undefined,
  now = new Date()
) {
  const account = signInAccount(site);
  if (account === undefined) return undefined;
  const holding = await listBrowserHoldingSites(workspaceId, now);
  return holding.some((other) => signInAccount(other) === account)
    ? account
    : undefined;
}

/**
 * A path the keep-alive visit must never open, whatever the run named: it
 * signs out, confirms, pays or deletes on a plain visit, or is a sign-in
 * page rather than the account.
 */
const unsafeAccountPath =
  /(?:^|[/_.-])(?:auth|cancel|checkout|confirm|delete|exit|log-?in|log-?out|oauth|pay|payment|remove|sign-?in|sign-?out|token|unsubscribe)(?:$|[/_.-])/iu;

/**
 * The pages a run reported it is signed in on (`SIGNED_IN:`), one per
 * domain, kept only on the domains that serve its errand: the line is the
 * page's word as much as the run's, and must not put a stranger's site on
 * record, nor a link that acts when opened. Query and fragment are dropped.
 */
function signedInPages(
  reported: string | undefined,
  site: string | null | undefined
) {
  const serving = servingDomains(site);
  const pages = new Map<string, string>();
  for (const [raw] of (reported ?? "").matchAll(
    /https:\/\/[^\s,;"'<>()[\]]+/gu
  )) {
    const url = URL.parse(raw);
    const host = hostOf(raw);
    const domain = host === undefined ? undefined : ownDomain(host);
    if (!url || domain === undefined || !serving.includes(domain)) continue;
    if (pages.has(domain) || unsafeAccountPath.test(url.pathname)) continue;
    pages.set(domain, `${url.origin}${url.pathname}`);
  }
  return pages;
}

/** A run that stopped on one of these did not get in with what was kept. */
const signInSteps = new Set<BrowserRunNeed>([
  "email_code",
  "password",
  "push",
  "sms_code",
]);

/**
 * Keep what a settled run found about the person's sign-ins. A sign-in is on
 * record only once its browser was stopped cleanly (`persisted`): until then
 * the profile does not have it, and a note saying it does would be a lie. A
 * run that stopped on a sign-in step marks the errand's domains signed out.
 * Never fatal: the report matters more than the record.
 */
export async function recordRunSignIns(
  row: { readonly site: string | null; readonly workspaceId: string },
  outcome: {
    readonly needs: BrowserRunNeed;
    readonly persisted: boolean;
    readonly signedIn: string | undefined;
  },
  now = new Date()
) {
  try {
    const pages = signedInPages(outcome.signedIn, row.site);
    if (outcome.persisted) {
      await Promise.all(
        [...pages].map(([domain, accountUrl]) =>
          recordBrowserSignIn(row.workspaceId, { accountUrl, domain, now })
        )
      );
    }
    if (signInSteps.has(outcome.needs)) {
      await recordBrowserSignOut(
        row.workspaceId,
        servingDomains(row.site).filter((domain) => !pages.has(domain)),
        now
      );
    }
  } catch (error) {
    console.warn("[browser-use] sign-ins could not be recorded", {
      cause: error,
    });
  }
}

/**
 * How long a sign-in seen by a run or a keep-alive visit is trusted. A
 * Госуслуги session is short and is not kept alive (`noRefreshDomains`), so
 * it counts only for the errands right after the one that signed in.
 */
function trustedFor(domain: string) {
  return domain === gosuslugiDomain ? 2 * 60 * 60_000 : 14 * 24 * 60 * 60_000;
}

/**
 * What Bro is told when an errand starts where the person's sign-in is
 * kept: that the run should get in without a code, so the person is not
 * warned about one up front. Undefined when nothing fresh is on record.
 */
export async function keptSignInNote(
  workspaceId: string,
  site: string | undefined,
  now = new Date()
) {
  try {
    const records = await readBrowserSignIns(workspaceId, servingDomains(site));
    const fresh = records.filter(
      (record) =>
        record.state === "signed_in" &&
        now.getTime() - record.checkedAt.getTime() < trustedFor(record.domain)
    );
    if (fresh.length === 0) return undefined;
    const seen = fresh
      .map(
        (record) =>
          `${record.domain} (last seen signed in ${record.checkedAt.toISOString().slice(0, 10)})`
      )
      .join(", ");
    return `Bro's browser kept the user's sign-in at ${seen} from an earlier errand, so the run should get in without asking them for a code. Do not warn the user about signing in or a code up front; if the site asks for one after all, the run stops and its outcome says so.`;
  } catch (error) {
    console.warn("[browser-use] sign-ins could not be read", { cause: error });
    return undefined;
  }
}

/**
 * Domains a keep-alive visit cannot help. Госуслуги ends a session within
 * hours and asks for a new code on a new device or address whatever the
 * cookies say, so a visit there would only spend money.
 */
const noRefreshDomains = [gosuslugiDomain];
/** The person stopped using a site this long ago: it is not kept alive. */
const refreshUseWindowMs = 30 * 24 * 60 * 60_000;
/** A visit reads one page and stops; the cloud ends a browser that hangs. */
const refreshBrowserMinutes = 3;
/** Visits per hourly tick. Each takes a browser slot for half a minute. */
const refreshesPerTick = 3;

/**
 * Visit, one at a time, the signed-in pages that are due, so the sites see
 * their session in use and its renewed cookies reach the profile. Nothing
 * is typed and nobody is asked: a page that turned into a sign-in is only
 * recorded, and the next errand there asks the person as usual. A workspace
 * with a browser up is skipped: whichever browser stops last is what the
 * profile keeps, and this visit's profile is older than that browser's.
 * `BROWSER_USE_SIGN_IN_REFRESH_DAYS=0` turns the visits off.
 */
export async function refreshDueSignIns(now = new Date()) {
  const days = env.BROWSER_USE_SIGN_IN_REFRESH_DAYS;
  if (days === 0) return;
  const dueBefore = new Date(now.getTime() - days * 24 * 60 * 60_000);
  const due = await listDueBrowserSignInRefreshes({
    dueBefore,
    excludedDomains: noRefreshDomains,
    limit: refreshesPerTick * 3,
    usedAfter: new Date(now.getTime() - refreshUseWindowMs),
  });
  const busy = new Set(
    await listWorkspacesHoldingBrowsers(
      due.map((record) => record.workspaceId),
      now
    )
  );
  const visits = due
    .filter((record) => !busy.has(record.workspaceId))
    .slice(0, refreshesPerTick);
  await visitInTurn(visits, { dueBefore, now });
}

type DueRefresh = Awaited<
  ReturnType<typeof listDueBrowserSignInRefreshes>
>[number];

/** One visit after another: each holds a browser slot while it runs. */
async function visitInTurn(
  visits: readonly DueRefresh[],
  options: { readonly dueBefore: Date; readonly now: Date }
): Promise<void> {
  const [next, ...rest] = visits;
  if (next === undefined) return;
  const outcome = await refreshSignIn(next, options);
  // Browser Use has no browser free, or no credits: the rest waits too.
  if (outcome === "stop") return;
  return visitInTurn(rest, options);
}

async function refreshSignIn(
  record: DueRefresh,
  options: { readonly dueBefore: Date; readonly now: Date }
) {
  const { accountUrl, domain, profileId, workspaceId } = record;
  if (accountUrl === null) return "skipped" as const;
  const claimed = await claimBrowserSignInRefresh(workspaceId, domain, options);
  if (!claimed) return "skipped" as const;
  let browser: Awaited<ReturnType<typeof createBrowserUseBrowser>>;
  try {
    browser = await createBrowserUseBrowser({
      customProxy: customProxy(),
      profileId,
      proxyCountryCode: env.BROWSER_USE_PROXY_COUNTRY,
      timeoutMinutes: refreshBrowserMinutes,
    });
  } catch (error) {
    console.warn("[browser-use] keep-alive browser could not start", {
      cause: error,
      domain,
    });
    return browserUseBusy(error) || browserUseOutOfCredits(error)
      ? ("stop" as const)
      : ("failed" as const);
  }
  let page: Awaited<ReturnType<typeof visitPageOverCdp>> | undefined;
  try {
    page = await visitPageOverCdp(browser.cdpUrl, accountUrl);
  } catch (error) {
    console.warn("[browser-use] keep-alive visit failed", {
      cause: error,
      domain,
    });
  } finally {
    // The stop is what writes the renewed cookies to the profile.
    try {
      await stopBrowserUseBrowser(browser.id);
    } catch (error) {
      console.warn("[browser-use] keep-alive browser could not be stopped", {
        cause: error,
        domain,
      });
    }
  }
  if (page === undefined) return "failed" as const;
  const signedIn = stillSignedIn(accountUrl, page);
  await recordBrowserSignInCheck(workspaceId, domain, {
    now: new Date(),
    signedIn,
  });
  console.info("[browser-use] sign-in kept alive", { domain, signedIn });
  return "visited" as const;
}

/** A host or path that is a sign-in page rather than an account page. */
const signInHostPattern =
  /^(?:auth|esia|id|login|oauth|passport|signin|sso)\./u;
const signInPathPattern =
  /(?:^|\/)(?:auth|authorize|login|oauth|passport|sign-?in|sign_in|sso)(?:\/|$|\.)/iu;

function signInPage(url: URL) {
  return (
    signInHostPattern.test(url.hostname) || signInPathPattern.test(url.pathname)
  );
}

/**
 * Whether the account page still showed the account: not a password field,
 * not sent to another site, and not sent to a sign-in page when the account
 * page itself was not one.
 */
function stillSignedIn(
  accountUrl: string,
  page: { readonly passwordField: boolean; readonly url: string }
) {
  if (page.passwordField) return false;
  const expected = URL.parse(accountUrl);
  const landed = URL.parse(page.url);
  if (!expected || !landed) return false;
  const expectedDomain = ownDomain(expected.hostname);
  if (expectedDomain !== ownDomain(landed.hostname)) return false;
  if (!signInPage(landed)) return true;
  return signInPage(expected) && landed.hostname === expected.hostname;
}
