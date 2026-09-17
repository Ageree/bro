import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  deleteTenantWipeTargets,
  previewTenantWipe,
  resolveWipeTenant,
  type WipeCounts,
} from "./lib/tenantWipe";
import { wipeRefuseMessage } from "./lib/wipePolicy";

const wipeCounts = v.object({
  tenant: v.number(),
  jobs: v.number(),
  orders: v.number(),
  sessions: v.number(),
  payments: v.number(),
  vaultItems: v.number(),
  vaultSecrets: v.number(),
  browserCharges: v.number(),
  browserSessions: v.number(),
  files: v.number(),
  wakeups: v.number(),
  watchers: v.number(),
  loginChallenges: v.number(),
});

const previewResult = v.union(
  v.object({
    ok: v.literal(true),
    tenantId: v.id("tenants"),
    phoneE164: v.string(),
    handle: v.string(),
    hasBrowserProfile: v.boolean(),
    hasPhotonConversation: v.boolean(),
    hasInkboxConversation: v.boolean(),
    hasTelegram: v.boolean(),
    counts: wipeCounts,
  }),
  v.object({
    ok: v.literal(false),
    reason: v.union(
      v.literal("invalid"),
      v.literal("missing"),
      v.literal("mismatch"),
    ),
  }),
);

/** Look up one person. Refuses unless phone and handle are the same tenant. */
export const previewByPhoneAndHandle = internalQuery({
  args: {
    phoneE164: v.string(),
    handle: v.string(),
  },
  returns: previewResult,
  handler: async (ctx, args) => {
    const resolved = await resolveWipeTenant(ctx, args.phoneE164, args.handle);
    if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
    const preview = await previewTenantWipe(ctx, resolved.tenant);
    return { ok: true as const, ...preview };
  },
});

/**
 * Delete every Convex row (and file blob) for one tenant.
 * Internal only. Both phone and handle must name that same row.
 * `confirm` is "wipe" so a CLI typo cannot delete.
 */
export const wipeByPhoneAndHandle = internalMutation({
  args: {
    phoneE164: v.string(),
    handle: v.string(),
    confirm: v.literal("wipe"),
  },
  returns: wipeCounts,
  handler: async (ctx, args): Promise<WipeCounts> => {
    const resolved = await resolveWipeTenant(ctx, args.phoneE164, args.handle);
    if (!resolved.ok) {
      throw new Error(wipeRefuseMessage(resolved.reason));
    }
    return await deleteTenantWipeTargets(ctx, resolved.tenant);
  },
});
