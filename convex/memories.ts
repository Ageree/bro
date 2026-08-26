import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";

export const wake = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .order("desc")
      .take(80);
    return rows.reverse().map((r) => r.line);
  },
});

export const note = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    line: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164, line }) => {
    assertSecret(secret);
    const text = line.trim().slice(0, 280);
    if (!text) return null;
    const recent = await ctx.db
      .query("memories")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .order("desc")
      .take(20);
    if (recent.some((r) => r.line === text)) return null;
    await ctx.db.insert("memories", { phoneE164, line: text });
    return null;
  },
});

export const search = query({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    needle: v.string(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, { secret, phoneE164, needle }) => {
    assertSecret(secret);
    const q = needle.trim().toLowerCase();
    if (!q) return [];
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_phone", (qq) => qq.eq("phoneE164", phoneE164))
      .take(200);
    return rows.filter((r) => r.line.toLowerCase().includes(q)).map((r) => r.line);
  },
});

export const forget = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    needle: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, { secret, phoneE164, needle }) => {
    assertSecret(secret);
    const q = needle.trim().toLowerCase();
    if (!q) return 0;
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_phone", (qq) => qq.eq("phoneE164", phoneE164))
      .take(200);
    let n = 0;
    for (const row of rows) {
      if (row.line.toLowerCase().includes(q)) {
        await ctx.db.delete(row._id);
        n++;
      }
    }
    return n;
  },
});
