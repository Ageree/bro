import { v, type Infer } from "convex/values";
import { doc } from "convex-helpers/validators";
import schema from "./schema";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertSecret } from "./secret";
import { isValidHandle, makeHandle, phoneBindDecision } from "./lib/accessPolicy";
import {
  BROWSER_JOBS_UNLIMITED,
  browserAllowance,
  browserAllowedOnLimitError,
  carryCountersOnTzChange,
  dayKey,
  DEFAULT_TZ,
  effectiveUsedCount,
  inboundOnAccountingError,
  isPaid,
  legacyUsedForPeriod,
  monthKey,
  msgAllowance,
  paywallDecision,
  rateLimitPeriodKey,
  usedCount,
} from "./lib/billingPolicy";
import {
  isValidIanaTimeZone,
  normalizeTz,
  sessionTzChangeDecision,
} from "./lib/tzPolicy";
import {
  browserWakeupClaimKey,
  claimMatchesRunPhase,
  decideWakeupClaim,
  parseWakeupClaim,
  type WakeupPhase,
} from "./lib/browserFollowPolicy";
import { periodConfig, rateLimiter } from "./lib/rateLimits";
import { chatConversationId } from "./lib/tenantConversation";
import {
  bindTelegramDecision,
  lastChannelOf,
  newTelegramBindToken,
  telegramBindExpiry,
  type HumanChannel,
} from "./lib/telegramPolicy";
import { findTenantByHandle, findTenantByPhone } from "./lib/tenantLookup";
import { isTestPhone } from "./lib/testTenantPolicy";
import { siteFromLoginTask } from "./lib/browserProfilePolicy";
import { startClaimIsLive } from "./lib/browserInjectPolicy";

/** `{ k: obj[k] }` for each key present with a defined value. Same shape as
 *  chaining `...(obj[k] !== undefined ? { [k]: obj[k] } : {})` per key. */
function definedEntries<T extends Record<string, unknown>>(
  obj: T,
  keys: readonly (keyof T)[],
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/** A blank conversation id never lands on the 1:1 wakeup/mail lane. */
function trimmedConversationId(
  conversationId: string | undefined,
): string | undefined {
  return conversationId?.trim() || undefined;
}

/** Full tenant document. Derived from the schema so a new column (e.g.
 *  `archiveSyncedAt`) can never be missing here: a hand-copied list once
 *  made every tenant read throw `ReturnsValidationError` in production
 *  and Bro went silent for that person. */
export const tenantDoc = doc(schema, "tenants");

async function tenantByPhone(ctx: MutationCtx, phoneE164: string) {
  const existing = await findTenantByPhone(ctx, phoneE164);
  if (existing) return existing;
  const id = await ctx.db.insert("tenants", {
    phoneE164,
    status: "active",
  });
  const created = await ctx.db.get(id);
  if (!created) throw new Error("tenant insert failed");
  return created;
}

export const attachCabinetLoginForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    identityId: v.string(),
    handle: v.optional(v.string()),
  },
  returns: v.object({
    handle: v.string(),
    attached: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const phone = args.phoneE164.trim();
    const identityId = args.identityId.trim();
    if (!phone) throw new Error("phoneE164 required");
    if (!identityId) throw new Error("identityId required");
    const tenant = await findTenantByPhone(ctx, phone);
    if (!tenant) throw new Error("unknown tenant");
    if (tenant.inkboxHandle && isValidHandle(tenant.inkboxHandle)) {
      if (!tenant.inkboxIdentityId) {
        await ctx.db.patch(tenant._id, { inkboxIdentityId: identityId });
      }
      return { handle: tenant.inkboxHandle, attached: false };
    }
    let handle = args.handle?.trim() || makeHandle();
    if (!isValidHandle(handle)) throw new Error("invalid handle");
    for (let i = 0; i < 8; i++) {
      const taken = await findTenantByHandle(ctx, handle);
      if (!taken) break;
      handle = makeHandle();
    }
    const taken = await findTenantByHandle(ctx, handle);
    if (taken) throw new Error("handle unavailable");
    await ctx.db.patch(tenant._id, {
      inkboxHandle: handle,
      inkboxIdentityId: tenant.inkboxIdentityId || identityId,
    });
    return { handle, attached: true };
  },
});

export const getByPhone = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    return await findTenantByPhone(ctx, phoneE164);
  },
});

export const getByHandle = query({
  args: { secret: v.string(), handle: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, handle }) => {
    assertSecret(secret);
    return await findTenantByHandle(ctx, handle);
  },
});

export const getByConversation = query({
  args: { secret: v.string(), conversationId: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, conversationId }) => {
    assertSecret(secret);
    const photon = await ctx.db
      .query("tenants")
      .withIndex("by_photon_conversation", (q) =>
        q.eq("photonConversationId", conversationId),
      )
      .unique();
    if (photon) return photon;
    return await ctx.db
      .query("tenants")
      .withIndex("by_conversation", (q) =>
        q.eq("inkboxConversationId", conversationId),
      )
      .unique();
  },
});

export const getByEmail = query({
  args: { secret: v.string(), emailAddress: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, emailAddress }) => {
    assertSecret(secret);
    const email = emailAddress.trim().toLowerCase();
    if (!email) return null;
    const rows = await ctx.db
      .query("tenants")
      .withIndex("by_email", (q) => q.eq("emailAddress", email))
      .take(2);
    // Fail closed: zero or two matches never wake a person.
    if (rows.length !== 1) return null;
    return rows[0]!;
  },
});

export const upsert = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    inkboxConversationId: v.optional(v.string()),
    emailAddress: v.optional(v.string()),
  },
  returns: tenantDoc,
  handler: async (ctx, { secret, phoneE164, inkboxConversationId, emailAddress }) => {
    assertSecret(secret);
    const email = emailAddress?.trim().toLowerCase();
    const existing = await findTenantByPhone(ctx, phoneE164);
    const oneToOneConversationId = trimmedConversationId(inkboxConversationId);
    if (existing) {
      const patch: {
        inkboxConversationId?: string;
        emailAddress?: string;
      } = {};
      if (
        oneToOneConversationId &&
        existing.inkboxConversationId !== oneToOneConversationId
      ) {
        patch.inkboxConversationId = oneToOneConversationId;
      }
      if (email && existing.emailAddress !== email) patch.emailAddress = email;
      if (Object.keys(patch).length) {
        await ctx.db.patch(existing._id, patch);
        return { ...existing, ...patch };
      }
      return existing;
    }
    const id = await ctx.db.insert("tenants", {
      phoneE164,
      status: "active",
      inkboxConversationId: oneToOneConversationId,
      emailAddress: email || undefined,
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("tenant insert failed");
    return created;
  },
});

export const tzChangeResult = v.union(
  v.object({ ok: v.literal(true), tz: v.string() }),
  v.object({
    ok: v.literal(false),
    code: v.union(v.literal("unbound"), v.literal("invalid")),
  }),
);

/** Counter-carry + patch. Caller already validated IANA and ownership. */
export async function applyTimezoneChange(
  ctx: MutationCtx,
  tenant: Doc<"tenants">,
  tz: string,
  now: number,
): Promise<void> {
  const prevTz = tenant.tz ?? DEFAULT_TZ;
  if (prevTz === tz) {
    await ctx.db.patch(tenant._id, { tz });
    return;
  }
  const config = periodConfig();
  const prevDayKey = dayKey(now, prevTz);
  const prevMonthKey = monthKey(now, prevTz);
  // Component keys are tz-scoped; read old-window used so a tz flip
  // does not drop the component half of effectiveUsedCount.
  const { value: msgsRemaining } = await rateLimiter.getValue(
    ctx,
    "msgsPerDay",
    { key: rateLimitPeriodKey(tenant._id, prevDayKey), config },
  );
  const { value: browserRemaining } = await rateLimiter.getValue(
    ctx,
    "browserJobsPerMonth",
    { key: rateLimitPeriodKey(tenant._id, prevMonthKey), config },
  );
  const carry = carryCountersOnTzChange({
    now,
    prevTz,
    nextTz: tz,
    msgsDayKey: tenant.msgsDayKey,
    msgsDayCount: tenant.msgsDayCount,
    browserMonthKey: tenant.browserMonthKey,
    browserMonthCount: tenant.browserMonthCount,
    paywallSentDayKey: tenant.paywallSentDayKey,
    msgsComponentUsed: usedCount(msgsRemaining),
    browserComponentUsed: usedCount(browserRemaining),
  });
  await ctx.db.patch(tenant._id, { tz, ...carry });
}

export async function applyTimezoneForTenantId(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; tz: string; now: number },
): Promise<{ ok: true; tz: string } | { ok: false; code: "unbound" | "invalid" }> {
  const tenant = await ctx.db.get(args.tenantId);
  if (!tenant) return { ok: false, code: "invalid" };
  const decision = sessionTzChangeDecision({
    phoneE164: tenant.phoneE164,
    tz: args.tz,
  });
  if (!decision.ok) return decision;
  await applyTimezoneChange(ctx, tenant, decision.tz, args.now);
  return { ok: true, tz: decision.tz };
}

export const setTimezone = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    tz: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164, tz }) => {
    assertSecret(secret);
    const nextTz = normalizeTz(tz);
    if (!isValidIanaTimeZone(nextTz)) {
      throw new Error("invalid timezone");
    }
    const tenant = await tenantByPhone(ctx, phoneE164);
    await applyTimezoneChange(ctx, tenant, nextTz, Date.now());
    return null;
  },
});

export const setTimezoneForTenantId = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    tz: v.string(),
    now: v.number(),
  },
  returns: tzChangeResult,
  handler: async (ctx, args) => applyTimezoneForTenantId(ctx, args),
});

export const setBrowser = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    browserSessionId: v.optional(v.string()),
    browserLiveUrl: v.optional(v.string()),
    browserLoginLinkSentAt: v.optional(v.number()),
    browserRunId: v.optional(v.string()),
    browserTask: v.optional(v.string()),
    browserStatus: v.optional(v.string()),
    browserStartedAt: v.optional(v.number()),
    browserStartingAt: v.optional(v.number()),
    browserStartingTask: v.optional(v.string()),
    browserPendingSteer: v.optional(v.string()),
    browserPendingSteerAt: v.optional(v.number()),
    browserProfileId: v.optional(v.string()),
    browserCookieDomains: v.optional(v.array(v.string())),
    browserProfileSyncedAt: v.optional(v.number()),
    browserNeed: v.optional(v.string()),
    browserNeedSince: v.optional(v.number()),
    browserNeedDetail: v.optional(v.string()),
    browserPaying: v.optional(v.boolean()),
    browserPayHosts: v.optional(v.array(v.string())),
    browserNextTask: v.optional(v.string()),
    browserOutcome: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing) throw new Error("unknown tenant");
    const patch = definedEntries(args, [
      "browserSessionId",
      "browserLiveUrl",
      "browserLoginLinkSentAt",
      "browserRunId",
      "browserTask",
      "browserStatus",
      "browserStartedAt",
      "browserStartingAt",
      "browserStartingTask",
      "browserPendingSteer",
      "browserPendingSteerAt",
      "browserProfileId",
      "browserCookieDomains",
      "browserProfileSyncedAt",
      "browserNeed",
      "browserNeedSince",
      "browserNeedDetail",
      "browserPaying",
      "browserPayHosts",
      "browserNextTask",
      "browserOutcome",
    ]);
    const isNewRun = Boolean(args.browserRunId && existing.browserRunId !== args.browserRunId);
    // The run this start claim was for now exists: the claim has done its job,
    // so drop it — leaving it would keep `cloudStartInFlight` true for two
    // more minutes and make the next errand look like a start already in
    // flight. Only a NEW run id clears it: a poll re-persisting the previous
    // run must not cancel a claim that belongs to a start still in flight.
    if (isNewRun && args.browserStartingAt === undefined) {
      patch.browserStartingAt = 0;
      patch.browserStartingTask = "";
    }
    if (isNewRun) {
      // A fresh run/errand: the previous run's blocker and stored result are
      // stale and must never leak into the new one. `browserNextTask` is the
      // one thing that survives — it is what queued this new run in the
      // first place (busy → done → nextTask), so keep it unless the caller
      // explicitly overwrites it above.
      patch.browserLoginLinkSentAt = undefined;
      patch.browserNeed = undefined;
      patch.browserNeedSince = undefined;
      patch.browserNeedDetail = undefined;
      patch.browserOutcome = undefined;
    }
    await ctx.db.patch(existing._id, {
      ...patch,
      // Progress notes (browserProgressPolicy) are per-errand, not part of
      // setBrowser's own args — a fresh run must earn its own
      // "opened"/"slow"/"long" milestones again.
      ...(isNewRun ? { browserProgressSent: undefined } : {}),
    });
    return null;
  },
});

export const countProvisioned = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    // Table is ~BRO_IDENTITY_CAP (~100) plus a few unbound rows. A take(N)
    // on raw docs undercounts when unbound tenants sit in the first page
    // (by_handle is optional, so missing handles are not a cheap range).
    // Full collect + TS filter is enough at this scale.
    // eslint-disable-next-line @convex-dev/no-query-collect
    const rows = await ctx.db.query("tenants").collect();
    return rows.filter((r) => typeof r.inkboxHandle === "string" && r.inkboxHandle.length > 0)
      .length;
  },
});

export const getByHandleInternal = internalQuery({
  args: { handle: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { handle }) => {
    return await findTenantByHandle(ctx, handle);
  },
});

export const getByPhoneInternal = internalQuery({
  args: { phoneE164: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { phoneE164 }) => {
    return await findTenantByPhone(ctx, phoneE164);
  },
});

export const patchBrowserInternal = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    browserStatus: v.optional(v.string()),
    browserSessionId: v.optional(v.string()),
    browserLiveUrl: v.optional(v.string()),
    browserNeed: v.optional(v.string()),
    browserNeedSince: v.optional(v.number()),
    browserNeedDetail: v.optional(v.string()),
    browserOutcome: v.optional(v.string()),
  },
  returns: v.object({ stale: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing || existing.browserRunId !== args.runId) {
      return { stale: true };
    }
    const patch = definedEntries(args, [
      "browserStatus",
      "browserSessionId",
      "browserLiveUrl",
      "browserNeed",
      "browserNeedSince",
      "browserNeedDetail",
      "browserOutcome",
    ]);
    if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
    return { stale: false };
  },
});

/** A run's terminal outcome resolved with no pending need — clear any
 *  blocker the same run had parked earlier (pollRun writes it, this undoes
 *  it once `parseCloudOutcome` says `needs: "none"`). Same runId gate as
 *  every other browser-state write, so a stale poll never clobbers a newer run. */
export const clearBrowserNeed = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing || existing.browserRunId !== args.runId) return null;
    await ctx.db.patch(existing._id, {
      browserNeed: undefined,
      browserNeedSince: undefined,
      browserNeedDetail: undefined,
    });
    return null;
  },
});

/** Public counterpart of `clearBrowserNeed` for agent-side callers (the inject
 *  path in `browser_task.ts`): a code/confirmation/correction just queued into
 *  the live session satisfies whatever the run was parked on, but the queued
 *  message usually resumes the *same* run id, so `setBrowser`'s own
 *  new-run-id auto-clear never fires — this clears it explicitly. Same runId
 *  gate as every other browser-state write. `setBrowser` cannot do this
 *  itself: its `definedEntries` picker only copies keys present with a
 *  defined value, so passing `browserNeed: undefined` through the wrapper
 *  never reaches the patch. */
export const clearBrowserNeedPublic = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    runId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing || existing.browserRunId !== args.runId) return null;
    await ctx.db.patch(existing._id, {
      browserNeed: undefined,
      browserNeedSince: undefined,
      browserNeedDetail: undefined,
    });
    return null;
  },
});

const browserStartClaim = v.object({
  /** true when THIS caller now owns the start and may create a Cloud run. */
  claimed: v.boolean(),
  /** The claim's own timestamp. On a WON claim it is what this caller wrote
   *  onto the row, and `releaseBrowserStart` compares against it so a turn can
   *  only ever drop ITS OWN claim (S6). On a REFUSED claim it is the sibling's
   *  stamp: what is already being started, so the caller can hold its
   *  follow-up for that errand instead of opening a second one. */
  startingAt: v.optional(v.number()),
  startingTask: v.optional(v.string()),
  browserSessionId: v.optional(v.string()),
  browserRunId: v.optional(v.string()),
});

/**
 * One Cloud start at a time, claimed BEFORE the start round-trips.
 *
 * `startRun()` takes seconds, and `browserRunId`/`browserSessionId` were only
 * persisted after it returned. A follow-up sent one second after the errand
 * («хочу забронировать ресторан» → «на воскресенье») therefore read a tenant
 * row with no session at all, decided "start", and opened a SECOND cloud run
 * carrying only the fragment as its whole task — a second charged job and one
 * orphaned live browser. The claim closes that window: it is a single Convex
 * transaction, so exactly one concurrent turn gets `claimed: true`.
 *
 * A claim older than `staleMs` (browserInjectPolicy's START_CLAIM_MS) is taken
 * over — a turn that died mid-start must never wedge the tenant forever.
 */
export const claimBrowserStart = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    task: v.string(),
    now: v.number(),
    staleMs: v.number(),
  },
  returns: browserStartClaim,
  handler: async (ctx, args): Promise<Infer<typeof browserStartClaim>> => {
    assertSecret(args.secret);
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing) throw new Error("unknown tenant");
    const at = existing.browserStartingAt ?? 0;
    if (startClaimIsLive(at, args.now, args.staleMs)) {
      return {
        claimed: false,
        startingAt: at,
        ...(existing.browserStartingTask
          ? { startingTask: existing.browserStartingTask }
          : {}),
        ...(existing.browserSessionId ? { browserSessionId: existing.browserSessionId } : {}),
        ...(existing.browserRunId ? { browserRunId: existing.browserRunId } : {}),
      };
    }
    await ctx.db.patch(existing._id, {
      browserStartingAt: args.now,
      browserStartingTask: args.task.slice(0, 2000),
    });
    // `startingAt` is handed back so the winner can release exactly the claim
    // it just took, and nothing else (see `releaseBrowserStart`).
    return { claimed: true, startingAt: args.now };
  },
});

/**
 * Drop a start claim that will never produce a run (the start threw, or the
 * turn decided not to start after all). Without this the tenant would look
 * "starting" for the whole START_CLAIM_MS and swallow the next errand.
 *
 * COMPARE-AND-CLEAR on `startingAt` (S6). This used to clear whatever claim
 * happened to be on the row, which made it a way to cancel SOMEBODY ELSE's
 * in-flight start — exactly the double-start the claim exists to prevent.
 * Turn A claimed at t0 and sat inside `startRun`; at t0+3s a `reset:true` turn
 * B wiped A's claim, took its own, and then could not cancel A's run because A
 * had not written its runId down yet. Two charged runs, A's browser orphaned
 * with no runId anyone could cancel. The same hazard exists without `reset`:
 * a turn whose own claim has already expired and been re-taken by a sibling
 * must not clear the sibling's claim on its way out.
 *
 * A mismatch is a no-op, not an error: the caller either never owned the claim
 * or its run already cleared it (`setBrowser` zeroes it on a new run id).
 */
export const releaseBrowserStart = mutation({
  args: { secret: v.string(), phoneE164: v.string(), startingAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing) return null;
    if ((existing.browserStartingAt ?? 0) !== args.startingAt) return null;
    await ctx.db.patch(existing._id, {
      browserStartingAt: 0,
      browserStartingTask: "",
    });
    return null;
  },
});

/** Park a follow-up that arrived while a start was still in flight. Appended,
 *  not overwritten: the human can type two details in a row and neither may be
 *  lost. Whoever sees the session first drains it (`takeBrowserPendingSteer`)
 *  and queues it into the live Cloud session. */
export const holdBrowserSteer = mutation({
  args: { secret: v.string(), phoneE164: v.string(), text: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing) return null;
    const text = args.text.trim();
    if (!text) return null;
    const held = (existing.browserPendingSteer ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (held.includes(text)) return null; // the same line twice is one line
    // Whole lines only, newest last, bounded — a partial line queued into a
    // Cloud session is worse than no line at all.
    const next = [...held, text.slice(0, 300)].slice(-5).join("\n");
    await ctx.db.patch(existing._id, {
      browserPendingSteer: next,
      browserPendingSteerAt: args.now,
    });
    return null;
  },
});

/** Read-and-clear in one transaction, so two turns racing to drain the held
 *  follow-up cannot queue it into the session twice. Text older than `ttlMs`
 *  is dropped rather than returned: it belonged to an errand that is over, and
 *  «на воскресенье» applied to somebody's next taxi is worse than losing it. */
export const takeBrowserPendingSteer = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    now: v.number(),
    ttlMs: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    assertSecret(args.secret);
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing) return "";
    const held = (existing.browserPendingSteer ?? "").trim();
    if (!held) return "";
    const at = existing.browserPendingSteerAt ?? 0;
    await ctx.db.patch(existing._id, { browserPendingSteer: "", browserPendingSteerAt: 0 });
    return args.now - at > args.ttlMs ? "" : held;
  },
});

const loginLinkClaim = v.object({
  send: v.boolean(),
  conversationId: v.optional(v.string()),
  site: v.optional(v.string()),
  liveUrl: v.optional(v.string()),
});

export const claimBrowserLoginLink = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    liveUrl: v.string(),
  },
  returns: loginLinkClaim,
  handler: async (ctx, args): Promise<Infer<typeof loginLinkClaim>> => {
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing || existing.browserRunId !== args.runId) {
      return { send: false };
    }
    if (existing.browserLoginLinkSentAt && existing.browserLoginLinkSentAt > 0) {
      return { send: false };
    }
    const conversationId = chatConversationId(existing);
    if (!conversationId) return { send: false };
    await ctx.db.patch(existing._id, {
      browserLiveUrl: args.liveUrl,
      browserLoginLinkSentAt: Date.now(),
    });
    return {
      send: true,
      conversationId,
      liveUrl: args.liveUrl,
      ...(siteFromLoginTask(existing.browserTask)
        ? { site: siteFromLoginTask(existing.browserTask) }
        : {}),
    };
  },
});

export const releaseBrowserLoginLink = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing || existing.browserRunId !== args.runId) return null;
    await ctx.db.patch(existing._id, { browserLoginLinkSentAt: undefined });
    return null;
  },
});

const progressClaim = v.object({
  send: v.boolean(),
  conversationId: v.optional(v.string()),
});

/** Same claim-before-send shape as claimBrowserLoginLink, keyed by note kind
 *  instead of a one-shot flag so several distinct notes can fire per run. */
export const claimBrowserProgress = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    key: v.string(),
  },
  returns: progressClaim,
  handler: async (ctx, args): Promise<Infer<typeof progressClaim>> => {
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing || existing.browserRunId !== args.runId) return { send: false };
    const sent = existing.browserProgressSent ?? [];
    if (sent.includes(args.key)) return { send: false };
    const conversationId = chatConversationId(existing);
    if (!conversationId) return { send: false };
    await ctx.db.patch(existing._id, { browserProgressSent: [...sent, args.key] });
    return { send: true, conversationId };
  },
});

export const releaseBrowserProgress = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    key: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    if (!existing || existing.browserRunId !== args.runId) return null;
    const sent = (existing.browserProgressSent ?? []).filter((k) => k !== args.key);
    await ctx.db.patch(existing._id, { browserProgressSent: sent });
    return null;
  },
});

const wakeupPhase = v.union(
  v.literal("done"),
  v.literal("need"),
  v.literal("failed"),
  v.literal("giveup"),
);

const wakeupClaimResult = v.union(
  v.object({
    ok: v.literal(false),
    reason: v.union(
      v.literal("stale_run"),
      v.literal("duplicate"),
      v.literal("pending_in_flight"),
    ),
  }),
  v.object({
    ok: v.literal(true),
    conversationId: v.optional(v.string()),
    inkboxHandle: v.optional(v.string()),
  }),
);

export const claimBrowserWakeup = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    phase: wakeupPhase,
  },
  returns: wakeupClaimResult,
  handler: async (ctx, args): Promise<Infer<typeof wakeupClaimResult>> => {
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    const now = Date.now();
    const phase = args.phase as WakeupPhase;
    const decision = decideWakeupClaim({
      tenantRunId: existing?.browserRunId,
      runId: args.runId,
      phase,
      existingClaim: existing?.browserWakeupClaim,
      now,
    });
    if (decision !== "ok") {
      return { ok: false as const, reason: decision };
    }
    if (!existing) return { ok: false as const, reason: "stale_run" };
    await ctx.db.patch(existing._id, {
      browserWakeupClaim: browserWakeupClaimKey(args.runId, phase, now, "pending"),
    });
    return {
      ok: true as const,
      conversationId: chatConversationId(existing),
      inkboxHandle: existing.inkboxHandle,
    };
  },
});

export const releaseBrowserWakeup = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    phase: wakeupPhase,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    const phase = args.phase as WakeupPhase;
    if (!existing || !claimMatchesRunPhase(existing.browserWakeupClaim, args.runId, phase)) {
      return null;
    }
    await ctx.db.patch(existing._id, { browserWakeupClaim: undefined });
    return null;
  },
});

export const confirmBrowserWakeup = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    phase: wakeupPhase,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await findTenantByPhone(ctx, args.phoneE164);
    const phase = args.phase as WakeupPhase;
    const parsed = parseWakeupClaim(existing?.browserWakeupClaim);
    if (
      !existing ||
      !parsed ||
      parsed.runId !== args.runId ||
      parsed.phase !== phase
    ) {
      return null;
    }
    await ctx.db.patch(existing._id, {
      browserWakeupClaim: browserWakeupClaimKey(
        args.runId,
        phase,
        parsed.claimedAtMs,
        "sent",
      ),
    });
    return null;
  },
});

export const insertProvisioned = internalMutation({
  args: {
    inkboxHandle: v.string(),
    inkboxIdentityId: v.string(),
    emailAddress: v.optional(v.string()),
    webhookSigningKey: v.optional(v.string()),
    dedicatedIMessageNumber: v.optional(v.string()),
    dedicatedIMessageNumberStatus: v.optional(v.string()),
    photonUserId: v.optional(v.string()),
    photonAssignedNumber: v.optional(v.string()),
    phoneE164: v.optional(v.string()),
  },
  returns: tenantDoc,
  handler: async (ctx, args) => {
    const existing = await findTenantByHandle(ctx, args.inkboxHandle);
    if (existing) {
      const patch: {
        photonUserId?: string;
        photonAssignedNumber?: string;
        phoneE164?: string;
      } = {};
      if (args.photonUserId && existing.photonUserId !== args.photonUserId) {
        patch.photonUserId = args.photonUserId;
      }
      if (
        args.photonAssignedNumber &&
        existing.photonAssignedNumber !== args.photonAssignedNumber
      ) {
        patch.photonAssignedNumber = args.photonAssignedNumber;
      }
      if (args.phoneE164 && !existing.phoneE164) {
        const holder = await findTenantByPhone(ctx, args.phoneE164);
        if (phoneBindDecision(holder?._id, existing._id) === "taken") {
          throw new Error("phone already bound to another tenant");
        }
        patch.phoneE164 = args.phoneE164;
      }
      if (Object.keys(patch).length) {
        await ctx.db.patch(existing._id, patch);
        return { ...existing, ...patch };
      }
      return existing;
    }
    if (args.phoneE164) {
      const holder = await findTenantByPhone(ctx, args.phoneE164);
      if (phoneBindDecision(holder?._id, undefined) === "taken") {
        throw new Error("phone already bound to another tenant");
      }
    }
    const email = args.emailAddress?.trim().toLowerCase();
    const id = await ctx.db.insert("tenants", {
      inkboxHandle: args.inkboxHandle,
      inkboxIdentityId: args.inkboxIdentityId,
      emailAddress: email || undefined,
      webhookSigningKey: args.webhookSigningKey,
      dedicatedIMessageNumber: args.dedicatedIMessageNumber,
      dedicatedIMessageNumberStatus: args.dedicatedIMessageNumberStatus,
      photonUserId: args.photonUserId,
      photonAssignedNumber: args.photonAssignedNumber,
      phoneE164: args.phoneE164,
      displayName: "Bro",
      status: "active",
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("tenant insert failed");
    return created;
  },
});

export const bindPhotonInbound = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    photonConversationId: v.string(),
    photonUserId: v.optional(v.string()),
    photonAssignedNumber: v.optional(v.string()),
    handle: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      tenant: tenantDoc,
      firstBind: v.boolean(),
    }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const phone = args.phoneE164.trim();
    const conversation = args.photonConversationId.trim();
    if (!phone || !conversation) {
      return { ok: false as const, reason: "missing fields" };
    }
    let tenant = args.handle ? await findTenantByHandle(ctx, args.handle) : null;
    if (!tenant) {
      tenant = await findTenantByPhone(ctx, phone);
    }
    if (!tenant && args.photonUserId) {
      tenant = await ctx.db
        .query("tenants")
        .withIndex("by_photon_user", (q) => q.eq("photonUserId", args.photonUserId!))
        .unique();
    }
    if (!tenant) {
      const id = await ctx.db.insert("tenants", {
        phoneE164: phone,
        status: "active",
        photonConversationId: conversation,
        photonUserId: args.photonUserId,
        photonAssignedNumber: args.photonAssignedNumber,
        lastChannel: "imessage",
      });
      const created = await ctx.db.get(id);
      if (!created) return { ok: false as const, reason: "missing" };
      return { ok: true as const, tenant: created, firstBind: true };
    }
    if (tenant.status === "disabled") {
      return { ok: false as const, reason: "disabled" };
    }
    if (tenant.phoneE164 && tenant.phoneE164 !== phone) {
      return { ok: false as const, reason: "wrong phone" };
    }
    const firstBind = !tenant.photonConversationId;
    const patch: {
      phoneE164?: string;
      photonConversationId?: string;
      photonUserId?: string;
      photonAssignedNumber?: string;
      lastChannel?: "imessage";
    } = { lastChannel: "imessage" };
    if (!tenant.phoneE164) patch.phoneE164 = phone;
    if (tenant.photonConversationId !== conversation) {
      patch.photonConversationId = conversation;
    }
    if (args.photonUserId && tenant.photonUserId !== args.photonUserId) {
      patch.photonUserId = args.photonUserId;
    }
    if (
      args.photonAssignedNumber &&
      tenant.photonAssignedNumber !== args.photonAssignedNumber
    ) {
      patch.photonAssignedNumber = args.photonAssignedNumber;
    }
    await ctx.db.patch(tenant._id, patch);
    const next = await ctx.db.get(tenant._id);
    if (!next) return { ok: false as const, reason: "missing" };
    return { ok: true as const, tenant: next, firstBind };
  },
});

export const markPhotonNudgeSent = mutation({
  args: {
    secret: v.string(),
    conversationId: v.string(),
    now: v.number(),
  },
  returns: v.object({ sent: v.boolean() }),
  handler: async (ctx, { secret, conversationId, now }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_conversation", (q) =>
        q.eq("inkboxConversationId", conversationId),
      )
      .unique();
    if (!tenant) return { sent: false };
    if (tenant.photonNudgeSentAt) return { sent: false };
    await ctx.db.patch(tenant._id, { photonNudgeSentAt: now });
    return { sent: true };
  },
});

export const bindInbound = mutation({
  args: {
    secret: v.string(),
    handle: v.string(),
    phoneE164: v.string(),
    inkboxConversationId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      tenant: tenantDoc,
      firstBind: v.boolean(),
    }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, { secret, handle, phoneE164, inkboxConversationId }) => {
    assertSecret(secret);
    const tenant = await findTenantByHandle(ctx, handle);
    if (!tenant) return { ok: false as const, reason: "unknown handle" };
    if (tenant.status === "disabled") {
      return { ok: false as const, reason: "disabled" };
    }
    if (tenant.phoneE164 && tenant.phoneE164 !== phoneE164) {
      return { ok: false as const, reason: "wrong phone" };
    }
    const firstBind = !tenant.phoneE164;
    const oneToOneConversationId = trimmedConversationId(inkboxConversationId);
    const patch: {
      phoneE164?: string;
      inkboxConversationId?: string;
    } = {};
    if (!tenant.phoneE164) patch.phoneE164 = phoneE164;
    if (
      oneToOneConversationId &&
      tenant.inkboxConversationId !== oneToOneConversationId
    ) {
      patch.inkboxConversationId = oneToOneConversationId;
    }
    if (Object.keys(patch).length) await ctx.db.patch(tenant._id, patch);
    const next = await ctx.db.get(tenant._id);
    if (!next) return { ok: false as const, reason: "missing" };
    return { ok: true as const, tenant: next, firstBind };
  },
});

export const countInboundMessage = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.object({
    decision: v.union(
      v.literal("allow"),
      v.literal("paywall"),
      v.literal("drop"),
    ),
    payUrl: v.optional(v.string()),
  }),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    if (tenant.status === "disabled") return { decision: "drop" as const };
    // A test tenant is not a customer: counting its messages would let a
    // nightly suite paywall itself halfway through, which reads as a
    // behavioural failure when it is only an accounting one.
    if (isTestPhone(phoneE164)) return { decision: "allow" as const };
    const now = Date.now();
    const key = dayKey(now, tenant.tz);
    const paid = isPaid(tenant.paidUntil, now);
    const allowance = msgAllowance(paid, {
      free: process.env.BRO_FREE_MSGS_PER_DAY,
      paid: process.env.BRO_PAID_MSGS_PER_DAY,
    });
    try {
      const periodKey = rateLimitPeriodKey(tenant._id, key);
      const config = periodConfig();
      await rateLimiter.limit(ctx, "msgsPerDay", { key: periodKey, config });
      const { value } = await rateLimiter.getValue(ctx, "msgsPerDay", {
        key: periodKey,
        config,
      });
      const count = effectiveUsedCount(
        usedCount(value),
        legacyUsedForPeriod(tenant.msgsDayKey, tenant.msgsDayCount, key),
      );
      const decision = paywallDecision({
        count,
        allowance,
        paywallSentDayKey: tenant.paywallSentDayKey,
        dayKey: key,
      });
      let payUrl: string | undefined;
      if (decision === "paywall") {
        await ctx.db.patch(tenant._id, { paywallSentDayKey: key });
        const base = (process.env.BRO_PAY_BASE ?? "").replace(/\/$/, "");
        if (base) payUrl = `${base}/pay?tid=${tenant._id}`;
      }
      return payUrl ? { decision, payUrl } : { decision };
    } catch (err) {
      console.error("billing count failed", err);
      if (tenant.paywallSentDayKey === key) {
        return inboundOnAccountingError({
          alreadySentToday: true,
          marked: false,
        });
      }
      try {
        await ctx.db.patch(tenant._id, { paywallSentDayKey: key });
        return inboundOnAccountingError({
          alreadySentToday: false,
          marked: true,
        });
      } catch (markErr) {
        console.error("paywallSentDayKey persist failed", markErr);
        return inboundOnAccountingError({
          alreadySentToday: false,
          marked: false,
        });
      }
    }
  },
});

export const markPaywallSent = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.object({ alreadySentToday: v.boolean() }),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    const key = dayKey(Date.now(), tenant.tz);
    if (tenant.paywallSentDayKey === key) return { alreadySentToday: true };
    await ctx.db.patch(tenant._id, { paywallSentDayKey: key });
    return { alreadySentToday: false };
  },
});

async function chargeBrowserJob(
  ctx: MutationCtx,
  tenant: Doc<"tenants">,
  now: number,
): Promise<boolean> {
  const key = monthKey(now, tenant.tz);
  const paid = isPaid(tenant.paidUntil, now);
  const allowance = browserAllowance(paid, {
    free: process.env.BRO_FREE_BROWSER_JOBS_PER_MONTH,
    paid: process.env.BRO_PAID_BROWSER_JOBS_PER_MONTH,
  });
  try {
    const periodKey = rateLimitPeriodKey(tenant._id, key);
    const config = periodConfig();
    const { value } = await rateLimiter.getValue(ctx, "browserJobsPerMonth", {
      key: periodKey,
      config,
    });
    const used = effectiveUsedCount(
      usedCount(value),
      legacyUsedForPeriod(tenant.browserMonthKey, tenant.browserMonthCount, key),
    );
    if (!BROWSER_JOBS_UNLIMITED && used >= allowance) return false;
    const { ok } = await rateLimiter.limit(ctx, "browserJobsPerMonth", {
      key: periodKey,
      config,
    });
    return BROWSER_JOBS_UNLIMITED ? true : ok;
  } catch (err) {
    console.error("billing browser count failed", err);
    return browserAllowedOnLimitError().allowed;
  }
}

/**
 * `chargeKey` dedupes a charge across retries of the *same* errand (a
 * pay-forced restart of the run just started, or an errand that resumes a
 * login within the reuse window — see `agent/tools/browser_task.ts`
 * `chargeKeyFor`) using the same `browserCharges`/`by_worker` pattern as
 * `startBrowserErrand` below, just with a `cloud:`-prefixed key so the two
 * charge kinds never collide in the same index.
 */
export const countBrowserJobStart = mutation({
  args: { secret: v.string(), phoneE164: v.string(), chargeKey: v.optional(v.string()) },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, { secret, phoneE164, chargeKey }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    // Same reason as `countInboundMessage`: a suite that exhausts a month of
    // browser jobs stops testing browser behaviour and starts testing the
    // quota message.
    if (isTestPhone(phoneE164)) return { allowed: true };
    const key = chargeKey?.trim();
    if (!key) {
      return { allowed: await chargeBrowserJob(ctx, tenant, Date.now()) };
    }
    const workerSessionId = `cloud:${key}`;
    const charged = await ctx.db
      .query("browserCharges")
      .withIndex("by_worker", (q) => q.eq("workerSessionId", workerSessionId))
      .first();
    if (charged && charged.tenantId === tenant._id) return { allowed: true };
    const now = Date.now();
    if (!(await chargeBrowserJob(ctx, tenant, now))) return { allowed: false };
    await ctx.db.insert("browserCharges", {
      tenantId: tenant._id,
      workerSessionId,
      chargedAt: now,
    });
    return { allowed: true };
  },
});

/**
 * Marks a `chargeKey` as already covered WITHOUT charging — a no-op insert
 * so a later `countBrowserJobStart({chargeKey})` call keyed the same way
 * finds a row and skips the charge. `chargeKeyFor` (agent/lib/browser-
 * task-policy.ts) keys a pay-forced restart or a login→errand continuation
 * off the run's *session id*, but the original charge for that errand was
 * keyed off a fresh, unrelated one-off key (the session id did not exist
 * yet when the charge happened) — without this alias the continuation's
 * lookup by session id never matches and it charges again. Call this once
 * the fresh run's session id is known, right after the real charge.
 */
export const aliasBrowserCharge = mutation({
  args: { secret: v.string(), phoneE164: v.string(), chargeKey: v.string() },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164, chargeKey }) => {
    assertSecret(secret);
    const tenant = await findTenantByPhone(ctx, phoneE164);
    if (!tenant) throw new Error("unknown tenant");
    const key = chargeKey.trim();
    if (!key) return null;
    const workerSessionId = `cloud:${key}`;
    const existing = await ctx.db
      .query("browserCharges")
      .withIndex("by_worker", (q) => q.eq("workerSessionId", workerSessionId))
      .first();
    if (existing) return null;
    await ctx.db.insert("browserCharges", {
      tenantId: tenant._id,
      workerSessionId,
      chargedAt: Date.now(),
    });
    return null;
  },
});

const ERRAND_CHARGE_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * One worker assignment costs one browser job, however many Kernel browsers it
 * opens. A login alone needs a second, writable browser, so charging per
 * browser would eat a free month in a single errand.
 */
export const startBrowserErrand = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    workerSessionId: v.string(),
  },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, { secret, phoneE164, workerSessionId }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    const charged = await ctx.db
      .query("browserCharges")
      .withIndex("by_worker", (q) => q.eq("workerSessionId", workerSessionId))
      .first();
    if (charged && charged.tenantId === tenant._id) return { allowed: true };

    const now = Date.now();
    if (!(await chargeBrowserJob(ctx, tenant, now))) return { allowed: false };
    await ctx.db.insert("browserCharges", {
      tenantId: tenant._id,
      workerSessionId,
      chargedAt: now,
    });

    const stale = await ctx.db
      .query("browserCharges")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
      .collect();
    for (const row of stale) {
      if (now - row.chargedAt > ERRAND_CHARGE_TTL_MS) await ctx.db.delete(row._id);
    }
    return { allowed: true };
  },
});

export const getByTelegram = query({
  args: { secret: v.string(), telegramUserId: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, telegramUserId }) => {
    assertSecret(secret);
    return await ctx.db
      .query("tenants")
      .withIndex("by_telegram", (q) => q.eq("telegramUserId", telegramUserId))
      .unique();
  },
});

/** Coarse enough that a burst of messages is one write, fine enough for the
 *  15-minute "he is in the chat right now" window the proactivity gate uses. */
const HUMAN_TOUCH_MIN_MS = 60_000;

export const touchLastChannel = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    lastChannel: v.union(v.literal("imessage"), v.literal("telegram")),
  },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164, lastChannel }) => {
    assertSecret(secret);
    const tenant = await findTenantByPhone(ctx, phoneE164);
    if (!tenant) return null;
    const channelChanged = lastChannelOf(tenant.lastChannel) !== lastChannel;
    // Both channels already park this call on every inbound message, so it is
    // the one place that knows "the person just wrote". The proactivity gate
    // needs that (`instinctPolicy.humanActive`): writing first into a live
    // conversation is an interruption, not initiative.
    //
    // The early return that used to sit here existed to avoid a write per
    // message; HUMAN_TOUCH_MIN_MS keeps that property — a burst of messages
    // still costs at most one patch a minute, which is finer than the
    // 15-minute window the gate reads it through.
    const now = Date.now();
    const humanStale = now - (tenant.lastHumanAt ?? 0) >= HUMAN_TOUCH_MIN_MS;
    if (!channelChanged && !humanStale) return null;
    await ctx.db.patch(tenant._id, {
      ...(channelChanged ? { lastChannel } : {}),
      ...(humanStale ? { lastHumanAt: now } : {}),
    });
    return null;
  },
});

export const mintTelegramBind = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), token: v.string(), alreadyLinked: v.boolean() }),
    v.object({ ok: v.literal(false), reason: v.literal("unbound") }),
  ),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await findTenantByPhone(ctx, phoneE164);
    if (!tenant?.phoneE164 || !chatConversationId(tenant)) {
      return { ok: false as const, reason: "unbound" as const };
    }
    const token = newTelegramBindToken();
    await ctx.db.patch(tenant._id, {
      telegramBindToken: token,
      telegramBindExpiresAt: telegramBindExpiry(Date.now()),
    });
    return {
      ok: true as const,
      token,
      alreadyLinked: Boolean(tenant.telegramUserId),
    };
  },
});

export const bindTelegram = mutation({
  args: {
    secret: v.string(),
    token: v.string(),
    telegramUserId: v.string(),
    telegramChatId: v.string(),
    telegramUsername: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      tenant: tenantDoc,
      firstBind: v.boolean(),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("expired"),
        v.literal("unknown_token"),
        v.literal("unbound_phone"),
        v.literal("already_other_user"),
        v.literal("already_other_tenant"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const token = args.token.trim().toLowerCase();
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_telegram_bind", (q) => q.eq("telegramBindToken", token))
      .unique();
    const other = await ctx.db
      .query("tenants")
      .withIndex("by_telegram", (q) => q.eq("telegramUserId", args.telegramUserId))
      .unique();
    const kind = bindTelegramDecision({
      now: Date.now(),
      tokenFound: Boolean(tenant),
      expiresAt: tenant?.telegramBindExpiresAt,
      tenantPhone: tenant?.phoneE164,
      tenantTelegramUserId: tenant?.telegramUserId,
      incomingUserId: args.telegramUserId,
      otherTenantPhone: other && other._id !== tenant?._id ? other.phoneE164 : undefined,
    });
    if (kind !== "ok" || !tenant) {
      return { ok: false as const, reason: kind === "ok" ? "unknown_token" : kind };
    }
    const firstBind = !tenant.telegramUserId;
    const username = args.telegramUsername?.replace(/^@/, "").trim();
    await ctx.db.patch(tenant._id, {
      telegramUserId: args.telegramUserId,
      telegramChatId: args.telegramChatId,
      telegramUsername: username || undefined,
      telegramBindToken: undefined,
      telegramBindExpiresAt: undefined,
      lastChannel: "telegram" satisfies HumanChannel,
    });
    const next = await ctx.db.get(tenant._id);
    if (!next) return { ok: false as const, reason: "unknown_token" as const };
    return { ok: true as const, tenant: next, firstBind };
  },
});
