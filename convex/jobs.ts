import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";

const MAX_OPEN = 8;
const LINE = 280;

const waitingFor = v.union(
  v.literal("human"),
  v.literal("email"),
  v.literal("browser"),
);

export const jobDoc = v.object({
  _id: v.id("jobs"),
  _creationTime: v.number(),
  tenantId: v.id("tenants"),
  goal: v.string(),
  doneWhen: v.string(),
  status: v.union(
    v.literal("open"),
    v.literal("waiting"),
    v.literal("done"),
    v.literal("failed"),
  ),
  waitingFor: v.optional(waitingFor),
  note: v.optional(v.string()),
  emailThreadId: v.optional(v.string()),
  emailMessageId: v.optional(v.string()),
});

function clip(s: string): string {
  return s.trim().slice(0, LINE);
}

export const open = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    goal: v.string(),
    doneWhen: v.string(),
  },
  returns: v.union(jobDoc, v.object({ error: v.string() })),
  handler: async (ctx, { secret, phoneE164, goal, doneWhen }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (!tenant) return { error: "unknown tenant" };
    const live = await ctx.db
      .query("jobs")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
      .take(32);
    const openN = live.filter(
      (j) => j.status === "open" || j.status === "waiting",
    ).length;
    if (openN >= MAX_OPEN) return { error: "too many open jobs" };
    const g = clip(goal);
    const d = clip(doneWhen);
    if (!g || !d) return { error: "goal and doneWhen required" };
    const id = await ctx.db.insert("jobs", {
      tenantId: tenant._id,
      goal: g,
      doneWhen: d,
      status: "open",
    });
    const row = await ctx.db.get(id);
    if (!row) return { error: "insert failed" };
    return row;
  },
});

export const wait = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    jobId: v.id("jobs"),
    waitingFor,
    note: v.optional(v.string()),
    emailThreadId: v.optional(v.string()),
    emailMessageId: v.optional(v.string()),
  },
  returns: v.union(jobDoc, v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .first();
    if (!tenant) return { error: "unknown tenant" };
    const job = await ctx.db.get(args.jobId);
    if (!job || job.tenantId !== tenant._id) return { error: "unknown job" };
    if (job.status === "done" || job.status === "failed") {
      return { error: "job already closed" };
    }
    const patch: {
      status: "waiting";
      waitingFor: typeof args.waitingFor;
      note?: string;
      emailThreadId?: string;
      emailMessageId?: string;
    } = {
      status: "waiting",
      waitingFor: args.waitingFor,
    };
    if (args.note) patch.note = clip(args.note);
    if (args.emailThreadId) patch.emailThreadId = args.emailThreadId;
    if (args.emailMessageId) patch.emailMessageId = args.emailMessageId;
    await ctx.db.patch(args.jobId, patch);
    const row = await ctx.db.get(args.jobId);
    if (!row) return { error: "missing" };
    return row;
  },
});

export const finish = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    jobId: v.id("jobs"),
    outcome: v.string(),
    failed: v.optional(v.boolean()),
  },
  returns: v.union(jobDoc, v.object({ error: v.string() })),
  handler: async (ctx, { secret, phoneE164, jobId, outcome, failed }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (!tenant) return { error: "unknown tenant" };
    const job = await ctx.db.get(jobId);
    if (!job || job.tenantId !== tenant._id) return { error: "unknown job" };
    await ctx.db.patch(jobId, {
      status: failed ? "failed" : "done",
      note: clip(outcome),
    });
    const row = await ctx.db.get(jobId);
    if (!row) return { error: "missing" };
    return row;
  },
});

export const touchMail = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    jobId: v.id("jobs"),
    emailThreadId: v.optional(v.string()),
    emailMessageId: v.optional(v.string()),
  },
  returns: v.union(jobDoc, v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .first();
    if (!tenant) return { error: "unknown tenant" };
    const job = await ctx.db.get(args.jobId);
    if (!job || job.tenantId !== tenant._id) return { error: "unknown job" };
    const patch: { emailThreadId?: string; emailMessageId?: string } = {};
    if (args.emailThreadId) patch.emailThreadId = args.emailThreadId;
    if (args.emailMessageId) patch.emailMessageId = args.emailMessageId;
    if (Object.keys(patch).length) await ctx.db.patch(args.jobId, patch);
    const row = await ctx.db.get(args.jobId);
    if (!row) return { error: "missing" };
    return row;
  },
});

export const listOpen = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.array(jobDoc),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (!tenant) return [];
    const rows = await ctx.db
      .query("jobs")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
      .take(32);
    return rows.filter((j) => j.status === "open" || j.status === "waiting");
  },
});

export const wake = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (!tenant) return [];
    const rows = await ctx.db
      .query("jobs")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
      .take(32);
    return rows
      .filter((j) => j.status === "open" || j.status === "waiting")
      .map((j) => {
        const wait = j.waitingFor ? ` waitingFor=${j.waitingFor}` : "";
        const note = j.note ? ` note=${j.note}` : "";
        const mail = j.emailMessageId ? ` emailMessageId=${j.emailMessageId}` : "";
        return `id=${j._id} goal="${j.goal}" doneWhen="${j.doneWhen}" status=${j.status}${wait}${note}${mail}`;
      });
  },
});
