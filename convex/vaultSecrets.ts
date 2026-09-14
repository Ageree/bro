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
  vaultKind,
} from "./lib/vaultPayload";

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
    handle: v.optional(v.string()),
  },
  returns: v.object({ handle: v.string(), replaced: v.boolean() }),
  handler: async (ctx, { tenantId, kind, label, secret: plaintext, handle: existingHandle }) => {
    if (!isValidVaultSecret(kind, plaintext)) {
      throw new Error("секрет заполнен не полностью");
    }
    const account = vaultAccountHint(kind, plaintext);
    const origin = vaultItemOrigin(kind, plaintext);
    let target = existingHandle?.trim() || "";
    if (target) {
      const item = await ctx.runQuery(internal.vault.itemByHandle, {
        tenantId,
        handle: target,
      });
      if (!item || item.kind !== kind) {
        throw new Error("запись не найдена");
      }
    } else if (kind === "login" && origin) {
      target =
        (await ctx.runQuery(internal.vault.loginHandleByOrigin, {
          tenantId,
          origin,
        })) ?? "";
    }
    if (target) {
      const ciphertext = encryptVaultSecret(
        vaultMasterKey(),
        tenantId,
        target,
        plaintext,
      );
      const replaced = await ctx.runMutation(internal.vault.replaceItem, {
        tenantId,
        handle: target,
        kind,
        label,
        account,
        ...(origin !== undefined ? { origin } : {}),
        ciphertext,
        now: Date.now(),
      });
      if (!replaced) throw new Error("не вышло обновить вход");
      return { handle: target, replaced: true };
    }
    const handle = crypto.randomUUID();
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
    return { handle, replaced: false };
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
