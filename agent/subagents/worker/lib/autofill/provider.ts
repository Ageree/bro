import { readVaultSecret } from "../../../../lib/convex";
import { vaultClaimValues } from "./claims";
import type { AutofillVaultAdapter } from "./service";

export const vaultAutofillProvider: AutofillVaultAdapter = {
  async materializeClaims(tenant, candidateId, target) {
    const item = await readVaultSecret(tenant, candidateId);
    if (!item) throw new Error("The selected vault item was not found.");
    if (!item.secret) throw new Error("The selected vault item has no secret.");

    const values = vaultClaimValues(
      item.kind,
      item.secret,
      target.origin,
      target.surface.kind,
    );
    return [...target.availableTokens].flatMap((token) => {
      const value = values.get(token);
      return value ? [{ id: crypto.randomUUID(), token, value }] : [];
    });
  },
};
