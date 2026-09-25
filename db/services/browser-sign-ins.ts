import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { browserProfiles, browserSignIns, db } from "@db";

/**
 * A run found the person signed in at `domain`, on a page only a signed-in
 * person sees. The page is kept for the keep-alive visit; a report without
 * one keeps the page an earlier run gave.
 */
export async function recordBrowserSignIn(
  workspaceId: string,
  input: {
    readonly accountUrl: string | undefined;
    readonly domain: string;
    readonly now: Date;
  }
) {
  await db
    .insert(browserSignIns)
    .values({
      accountUrl: input.accountUrl,
      checkedAt: input.now,
      domain: input.domain,
      state: "signed_in",
      usedAt: input.now,
      workspaceId,
    })
    .onConflictDoUpdate({
      set: {
        accountUrl: sql`coalesce(excluded.account_url, ${browserSignIns.accountUrl})`,
        checkedAt: input.now,
        state: "signed_in",
        usedAt: input.now,
      },
      target: [browserSignIns.workspaceId, browserSignIns.domain],
    });
}

/**
 * A run stopped on a sign-in at these domains: whatever was kept there no
 * longer lets it in. Only domains already on record change; a site the
 * person never signed in to has nothing to forget.
 */
export async function recordBrowserSignOut(
  workspaceId: string,
  domains: readonly string[],
  now: Date
) {
  if (domains.length === 0) return;
  await db
    .update(browserSignIns)
    .set({ checkedAt: now, state: "signed_out" })
    .where(
      and(
        eq(browserSignIns.workspaceId, workspaceId),
        inArray(browserSignIns.domain, [...domains])
      )
    );
}

export async function readBrowserSignIns(
  workspaceId: string,
  domains: readonly string[]
) {
  if (domains.length === 0) return [];
  return db
    .select()
    .from(browserSignIns)
    .where(
      and(
        eq(browserSignIns.workspaceId, workspaceId),
        inArray(browserSignIns.domain, [...domains])
      )
    );
}

/** The last time anyone looked: a run, a keep-alive visit or its claim. */
const lastLook = sql`greatest(${browserSignIns.refreshedAt}, ${browserSignIns.checkedAt})`;

function lookedAtBefore(time: Date) {
  return sql`${lastLook} < ${time.toISOString()}::timestamptz`;
}

/**
 * Sign-ins due a keep-alive visit, least recently looked at first: signed in
 * with a page to open, used by an errand since `usedAfter`, not visited or
 * seen since `dueBefore`, on a domain a visit can help, and in a workspace
 * that has a browser profile.
 */
export async function listDueBrowserSignInRefreshes(options: {
  readonly dueBefore: Date;
  readonly excludedDomains: readonly string[];
  readonly limit: number;
  readonly usedAfter: Date;
}) {
  return db
    .select({
      accountUrl: browserSignIns.accountUrl,
      domain: browserSignIns.domain,
      profileId: browserProfiles.profileId,
      workspaceId: browserSignIns.workspaceId,
    })
    .from(browserSignIns)
    .innerJoin(
      browserProfiles,
      eq(browserProfiles.workspaceId, browserSignIns.workspaceId)
    )
    .where(
      and(
        eq(browserSignIns.state, "signed_in"),
        isNotNull(browserSignIns.accountUrl),
        gt(browserSignIns.usedAt, options.usedAfter),
        lookedAtBefore(options.dueBefore),
        options.excludedDomains.length > 0
          ? notInArray(browserSignIns.domain, [...options.excludedDomains])
          : undefined
      )
    )
    .orderBy(asc(lastLook))
    .limit(options.limit);
}

/**
 * Claim one keep-alive visit: true when this call moved the visit mark, so
 * two ticks never open the same page, and a visit that died is simply due
 * again a period later.
 */
export async function claimBrowserSignInRefresh(
  workspaceId: string,
  domain: string,
  options: { readonly dueBefore: Date; readonly now: Date }
) {
  const rows = await db
    .update(browserSignIns)
    .set({ refreshedAt: options.now })
    .where(
      and(
        eq(browserSignIns.workspaceId, workspaceId),
        eq(browserSignIns.domain, domain),
        eq(browserSignIns.state, "signed_in"),
        lookedAtBefore(options.dueBefore)
      )
    )
    .returning({ domain: browserSignIns.domain });
  return rows.length > 0;
}

/** What the keep-alive visit saw: still signed in, or sent to a sign-in. */
export async function recordBrowserSignInCheck(
  workspaceId: string,
  domain: string,
  input: { readonly now: Date; readonly signedIn: boolean }
) {
  await db
    .update(browserSignIns)
    .set({
      checkedAt: input.now,
      state: input.signedIn ? "signed_in" : "signed_out",
    })
    .where(
      and(
        eq(browserSignIns.workspaceId, workspaceId),
        eq(browserSignIns.domain, domain)
      )
    );
}
