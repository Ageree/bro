import type { AutofillClaim, DetectedAutofillSurface } from "./protocol";

export interface AutofillFillTarget {
  readonly availableTokens: ReadonlySet<string>;
  readonly origin: string;
  readonly surface: DetectedAutofillSurface;
}

export interface AutofillVaultAdapter {
  materializeClaims(
    tenant: string,
    candidateId: string,
    target: AutofillFillTarget
  ): Promise<readonly AutofillClaim[]>;
}

export async function materializeAutofillClaims(
  tenant: string,
  candidateId: string,
  target: AutofillFillTarget,
  adapter: AutofillVaultAdapter
) {
  const claims = await adapter.materializeClaims(tenant, candidateId, target);
  if (claims.length === 0) {
    throw new Error("The selected vault item has no values for this form.");
  }
  return claims;
}
