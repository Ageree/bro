import { env } from "@shared/environment";
import { isPublicSuffix } from "@shared/browser/public-suffixes";
import {
  claimBrowserSignInRefresh,
  forgetBrowserSignIns,
  listBrowserSignIns,
  listDueBrowserSignInRefreshes,
  readBrowserSignIns,
  recordBrowserSignIn,
  recordBrowserSignInCheck,
  recordBrowserSignOut,
} from "@db/services/browser-sign-ins";
import {
  forgetBrowserProfile,
  listBrowserHoldingRuns,
  listWorkspacesHoldingBrowsers,
  workspaceUsesBrowserProfile,
} from "@db/services/browser-runs";
import {
  browserUseBusy,
  browserUseOutOfCredits,
  createBrowserUseBrowser,
  deleteBrowserUseProfile,
  stopBrowserUseBrowser,
} from "./client";
import { visitPageOverCdp } from "./cdp";
import type { BrowserRunNeed } from "./outcome";
import { customProxy } from "./proxy";
import {
  persistProfileCookies,
  personStepNeeds,
  recordedNeed,
} from "./release";
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
 *
 * It waits only for a run still working or a page waiting on the person's
 * code or approval. A settled page kept for anything else — a staged option,
 * a question — is past its sign-in: it is stopped now, which writes that
 * sign-in to the profile this errand starts from, and a follow-up to it
 * reopens the site (`closedPageLine`). Waiting for its idle stop would hold
 * the new errand a quarter of an hour.
 */
export async function accountInUse(
  workspaceId: string,
  site: string | null | undefined,
  now = new Date()
) {
  const account = signInAccount(site);
  if (account === undefined) return undefined;
  const holding = (await listBrowserHoldingRuns(workspaceId, now)).filter(
    (run) => signInAccount(run.site) === account
  );
  const stillHeld = await Promise.all(
    holding.map(async (run) => {
      const need = recordedNeed(run.outcome);
      if (
        run.completedAt === null ||
        run.sessionId === null ||
        need === undefined ||
        personStepNeeds.has(need)
      ) {
        return true;
      }
      return !(await persistProfileCookies(run.id, run.sessionId));
    })
  );
  return stillHeld.some(Boolean) ? account : undefined;
}

/**
 * Words of a link that acts when it is opened, or of a sign-in rather than
 * an account page, anywhere in its host, path or query: «/logout»,
 * «/logoutAll», «/api/doLogout», «/logoff», «/sessions/terminate»,
 * «/orders/1/cancelOrder», «logout.site.ru». The page names the link, not
 * Bro, so a real account page rejected by mistake only goes without its
 * keep-alive visit.
 */
const actingWord =
  /auth|cancel|checkout|confirm|delete|exit|log[-_]?(?:in|off|on|out)|oauth|order[-_]?(?:create|new)|pay|purchase|remove|revoke|session|sign[-_]?(?:in|off|on|out|up)|subscri|terminate|token|unsubscribe|verif/iu;

/**
 * An account page the keep-alive visit may open: https on the errand's own
 * domain, nothing escaped or hidden in its path (Chrome would read
 * «/%6Cogout» as «/logout»), and no acting word anywhere in it.
 */
function safeAccountPage(url: URL) {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return false;
  }
  if (/[%;@\\]/u.test(url.pathname) || url.port !== "") return false;
  return ![url.hostname, url.pathname, url.search].some((part) =>
    actingWord.test(part)
  );
}

/**
 * The pages a run reported it is signed in on (`SIGNED_IN:`), one per
 * domain, kept only on the domains that serve its errand and only when
 * opening them is safe (`safeAccountPage`): the line is the page's word as
 * much as the run's. Query and fragment are dropped.
 */
function signedInPages(
  reported: string | undefined,
  site: string | null | undefined
) {
  const serving = servingDomains(site);
  const pages = new Map<string, string>();
  for (const [raw] of (reported ?? "").matchAll(
    /https:\/\/[^\s,"'<>()[\]]+/gu
  )) {
    const url = URL.parse(raw);
    const host = hostOf(raw);
    const domain = host === undefined ? undefined : ownDomain(host);
    if (!url || domain === undefined || !serving.includes(domain)) continue;
    if (pages.has(domain) || !safeAccountPage(url)) continue;
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
 * Keep what a settled run found about the person's sign-ins. A page the run
 * is signed in on goes on record even while its browser is still up for the
 * person: until that browser is stopped cleanly the account stays held
 * (`accountInUse`) and no keep-alive visit touches the workspace, so nothing
 * uses the record before the sign-in is in the profile. A run that stopped
 * on a sign-in step, or said it is signed in nowhere, marks the errand's
 * domains signed out — «выйди из Озона» ends the visits there. Never fatal:
 * the report matters more than the record.
 */
export async function recordRunSignIns(
  row: { readonly site: string | null; readonly workspaceId: string },
  outcome: {
    readonly needs: BrowserRunNeed;
    readonly signedIn: string | undefined;
    readonly signedInNone: boolean;
  },
  now = new Date()
) {
  try {
    const pages = signedInPages(outcome.signedIn, row.site);
    await Promise.all(
      [...pages].map(([domain, accountUrl]) =>
        recordBrowserSignIn(row.workspaceId, { accountUrl, domain, now })
      )
    );
    if (signInSteps.has(outcome.needs) || outcome.signedInNone) {
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

/** How long a sign-in seen by a run or a keep-alive visit is trusted. */
const trustedForMs = 14 * 24 * 60 * 60_000;

/**
 * What Bro is told when an errand starts where the person's sign-in is
 * kept: that the run will likely get in without a code, so the person is
 * not warned about one up front — never a promise. Never for Госуслуги or a
 * site that signs in through it: each errand opens a new browser on a new
 * address, and Госуслуги asks for a code there whatever the cookies say, so
 * the wave-5 warning (`gosuslugiCodeNote`) stands. Undefined when nothing
 * fresh is on record.
 */
export async function keptSignInNote(
  workspaceId: string,
  site: string | undefined,
  now = new Date()
) {
  if (signInAccount(site) === gosuslugiDomain) return undefined;
  try {
    const records = await readBrowserSignIns(workspaceId, servingDomains(site));
    const fresh = records.filter(
      (record) =>
        record.state === "signed_in" &&
        record.domain !== gosuslugiDomain &&
        now.getTime() - record.checkedAt.getTime() < trustedForMs
    );
    if (fresh.length === 0) return undefined;
    const seen = fresh
      .map(
        (record) =>
          `${record.domain} (last seen signed in ${record.checkedAt.toISOString().slice(0, 10)})`
      )
      .join(", ");
    return `Bro's browser kept the user's sign-in at ${seen} from an earlier errand, so the run will likely get in without a code. There is no need to warn the user about a code up front, but do not promise them there will be none: if the site asks for one after all, the run stops and you ask then.`;
  } catch (error) {
    console.warn("[browser-use] sign-ins could not be read", { cause: error });
    return undefined;
  }
}

/**
 * The sites on record for the workspace, as the person can be told them:
 * where Bro's browser was last seen signed in, and where it was not.
 */
export async function listKeptSignIns(workspaceId: string) {
  const records = await listBrowserSignIns(workspaceId);
  return records.map((record) => ({
    lastSeen: record.checkedAt.toISOString().slice(0, 10),
    site: record.domain,
    state: record.state,
  }));
}

/**
 * Forget the person's sign-ins on sites. For one site its record goes, so
 * Bro stops opening it on its own and stops expecting to be signed in there;
 * the cookies stay in the profile. For every site the Browser Use profile is
 * deleted with all its cookies and the next errand starts a new, empty one —
 * signed out everywhere. That waits while an errand still uses the profile:
 * a run or a queued start would be left on a profile that is gone.
 */
export async function forgetSignIns(
  workspaceId: string,
  site: string | undefined,
  now = new Date()
) {
  const host = hostOf(
    site?.includes("://") === true ? site : `https://${site ?? ""}`
  );
  if (site !== undefined) {
    const domain = host === undefined ? undefined : ownDomain(host);
    if (domain === undefined) return { kind: "unknown_site" as const };
    const forgotten = await forgetBrowserSignIns(workspaceId, [domain]);
    return { domains: forgotten, kind: "site" as const, site: domain };
  }
  if (await workspaceUsesBrowserProfile(workspaceId, now)) {
    return { kind: "busy" as const };
  }
  const forgotten = await forgetBrowserSignIns(workspaceId);
  const profileId = await forgetBrowserProfile(workspaceId);
  let profileDeleted = profileId === undefined;
  if (profileId !== undefined) {
    try {
      await deleteBrowserUseProfile(profileId);
      profileDeleted = true;
    } catch (error) {
      console.warn("[browser-use] the forgotten profile could not be deleted", {
        cause: error,
      });
    }
  }
  return { domains: forgotten, kind: "all" as const, profileDeleted };
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
    page = await visitPageOverCdp(browser.cdpUrl, accountUrl, domain);
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
  const signedIn = stillSignedIn(page);
  await recordBrowserSignInCheck(workspaceId, domain, {
    now: new Date(),
    signedIn,
  });
  console.info("[browser-use] sign-in kept alive", { domain, signedIn });
  return "visited" as const;
}

/**
 * Whether the account page still showed the account: it stayed on the page
 * on record (the visit blocks and reports any other, `leftPage`) and shows
 * no password field. Anything else — a redirect to the home page after the
 * session ended, a sign-in form, another site's sign-in — counts as signed
 * out, which also ends the visits: a page that is not the recorded one is
 * never opened again.
 */
function stillSignedIn(page: {
  readonly leftPage: boolean;
  readonly passwordField: boolean;
}) {
  return !page.leftPage && !page.passwordField;
}
