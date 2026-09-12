import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import schema from "./schema";
import { mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";
import {
  mergeParticipantPhones,
  normalizeE164,
  resolveGroupOwner,
  uniquePhones,
} from "./lib/groupChatPolicy";
import { findTenantByHandle } from "./lib/tenantLookup";

export const groupChatDoc = doc(schema, "groupChats");

export const getByConversation = query({
  args: { secret: v.string(), conversationId: v.string() },
  returns: v.union(groupChatDoc, v.null()),
  handler: async (ctx, { secret, conversationId }) => {
    assertSecret(secret);
    return await ctx.db
      .query("groupChats")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .first();
  },
});

export const bindInbound = mutation({
  args: {
    secret: v.string(),
    conversationId: v.string(),
    senderPhone: v.string(),
    participants: v.array(v.string()),
    handle: v.optional(v.string()),
    ownerPhone: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      group: groupChatDoc,
      ownerPhoneE164: v.string(),
      inkboxHandle: v.string(),
      firstGroup: v.boolean(),
    }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const conversationId = args.conversationId.trim();
    if (!conversationId) return { ok: false as const, reason: "missing conversation" };

    const existing = await ctx.db
      .query("groupChats")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .first();

    let ownerPhone: string | undefined;
    let inkboxHandle = "";
    if (existing) {
      if (existing.status === "disabled") {
        return { ok: false as const, reason: "disabled" };
      }
      ownerPhone = existing.ownerPhoneE164;
      inkboxHandle = existing.inkboxHandle;
    } else if (args.handle) {
      const tenant = await findTenantByHandle(ctx, args.handle);
      if (!tenant) return { ok: false as const, reason: "unknown handle" };
      if (tenant.status === "disabled") {
        return { ok: false as const, reason: "disabled" };
      }
      if (!tenant.phoneE164) {
        return { ok: false as const, reason: "not bound" };
      }
      ownerPhone = tenant.phoneE164;
      inkboxHandle = tenant.inkboxHandle ?? args.handle;
    } else if (args.ownerPhone) {
      ownerPhone = resolveGroupOwner({
        tenantPhone: args.ownerPhone,
        senderPhone: args.senderPhone,
        participants: args.participants,
      });
    }
    if (!ownerPhone) return { ok: false as const, reason: "no owner" };
    if (!inkboxHandle && args.handle) inkboxHandle = args.handle;
    if (!existing && !inkboxHandle) {
      return { ok: false as const, reason: "missing handle" };
    }

    const participants = uniquePhones([
      ownerPhone,
      args.senderPhone,
      ...args.participants,
    ]);
    const senderPhone = normalizeE164(args.senderPhone);

    if (existing) {
      const nextParticipants = mergeParticipantPhones(
        existing.participants,
        participants,
      );
      const patch: {
        participants?: string[];
        lastSenderPhone?: string;
        inkboxHandle?: string;
      } = {};
      if (nextParticipants.join("\0") !== existing.participants.join("\0")) {
        patch.participants = nextParticipants;
      }
      if (senderPhone && existing.lastSenderPhone !== senderPhone) {
        patch.lastSenderPhone = senderPhone;
      }
      if (inkboxHandle && existing.inkboxHandle !== inkboxHandle) {
        patch.inkboxHandle = inkboxHandle;
      }
      if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
      const next = await ctx.db.get(existing._id);
      if (!next) return { ok: false as const, reason: "missing" };
      return {
        ok: true as const,
        group: next,
        ownerPhoneE164: next.ownerPhoneE164,
        inkboxHandle: next.inkboxHandle,
        firstGroup: false,
      };
    }

    const id = await ctx.db.insert("groupChats", {
      conversationId,
      ownerPhoneE164: ownerPhone,
      inkboxHandle,
      participants,
      status: "active",
      createdAt: Date.now(),
      lastSenderPhone: senderPhone,
      greeted: false,
    });
    const created = await ctx.db.get(id);
    if (!created) return { ok: false as const, reason: "insert failed" };
    return {
      ok: true as const,
      group: created,
      ownerPhoneE164: created.ownerPhoneE164,
      inkboxHandle: created.inkboxHandle,
      firstGroup: true,
    };
  },
});

