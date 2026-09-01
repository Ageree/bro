import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  isDuplicate,
  lineMatches,
  normalizeLine,
  overflowAfterInsert,
  SCAN_LINES,
  WAKE_LINES,
} from "./lib/memoryPolicy";
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
      .take(WAKE_LINES);
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
    const text = normalizeLine(line);
    if (!text) return null;
    const recent = await ctx.db
      .query("memories")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .order("desc")
      .take(SCAN_LINES);
    if (isDuplicate(recent.map((r) => r.line), text)) return null;
    await ctx.db.insert("memories", { phoneE164, line: text });
    // Keep one person's store bounded: drop the oldest lines beyond the cap.
    const overflow = overflowAfterInsert(recent.length);
    for (let i = 0; i < overflow; i++) {
      const row = recent[recent.length - 1 - i];
      if (row) await ctx.db.delete(row._id);
    }
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
    if (!needle.trim()) return [];
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_phone", (qq) => qq.eq("phoneE164", phoneE164))
      .order("desc")
      .take(SCAN_LINES);
    return rows
      .reverse()
      .filter((r) => lineMatches(r.line, needle))
      .map((r) => r.line);
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
    if (!needle.trim()) return 0;
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_phone", (qq) => qq.eq("phoneE164", phoneE164))
      .order("desc")
      .take(SCAN_LINES);
    let n = 0;
    for (const row of rows) {
      if (lineMatches(row.line, needle)) {
        await ctx.db.delete(row._id);
        n++;
      }
    }
    return n;
  },
});
