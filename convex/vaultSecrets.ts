"use node";

import { v, type Infer } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertSecret } from "./secret";
import {
  decryptVaultSecret,
  encryptVaultSecret,
  vaultMasterKey,
} from "../shared/vaultCrypto";
import {
  isValidVaultSecret,
  vaultAccountHint,
  vaultItemOrigin,
} from "./lib/vaultPayload";

const vaultKind = v.union(
  v.literal("login"),
  v.literal("payment"),
  v.literal("address"),
  v.literal("contact"),
);

const readResult = v.union(
  v.object({
    kind: vaultKind,
    origin: v.optional(v.string()),
    secret: v.string(),
  }),
  v.null(),
);

export const save = internalAction({
  args: {
    tenantId: v.id("tenants"),
    kind: vaultKind,
    label: v.string(),
    secret: v.string(),
  },
  returns: v.object({ handle: v.string() }),
  handler: async (ctx, { tenantId, kind, label, secret: plaintext }) => {
    if (!isValidVaultSecret(kind, plaintext)) {
      throw new Error("секрет заполнен не полностью");
    }
    const handle = crypto.randomUUID();
    const account = vaultAccountHint(kind, plaintext);
    const origin = vaultItemOrigin(kind, plaintext);
    const ciphertext = encryptVaultSecret(
      vaultMasterKey(),
      tenantId,
      handle,
      plaintext,
    );
    await ctx.runMutation(internal.vault.insertItem, {
      tenantId,
      handle,
      kind,
      label,
      account,
      ...(origin !== undefined ? { origin } : {}),
      ciphertext,
      now: Date.now(),
    });
    return { handle };
  },
});

export const readForAgent = action({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    handle: v.string(),
  },
  returns: readResult,
  handler: async (
    ctx,
    { secret: authSecret, phoneE164, handle },
  ): Promise<Infer<typeof readResult>> => {
    assertSecret(authSecret);
    const tenantId = await ctx.runQuery(internal.vault.tenantIdForPhone, {
      phoneE164,
    });
    if (!tenantId) return null;
    const item = await ctx.runQuery(internal.vault.itemByHandle, {
      tenantId,
      handle,
    });
    const stored = await ctx.runQuery(internal.vault.ciphertextByHandle, {
      tenantId,
      handle,
    });
    if (!item || !stored) return null;
    const plaintext = decryptVaultSecret(
      vaultMasterKey(),
      tenantId,
      handle,
      stored.ciphertext,
    );
    return {
      kind: item.kind,
      origin: item.origin,
      secret: plaintext,
    };
  },
});
