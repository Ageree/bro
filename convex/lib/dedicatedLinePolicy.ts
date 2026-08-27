/** Env-gated Dedicated iMessage Line. Off = shared router pool. */

export function dedicatedLineEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type IdentityCreateBody = {
  agent_handle: string;
  display_name: string;
  imessage_enabled: true;
  claim_imessage_number?: true;
};

export function identityCreateBody(opts: {
  handle: string;
  displayName: string;
  dedicatedLine: boolean;
}): IdentityCreateBody {
  const body: IdentityCreateBody = {
    agent_handle: opts.handle,
    display_name: opts.displayName,
    imessage_enabled: true,
  };
  if (opts.dedicatedLine) body.claim_imessage_number = true;
  return body;
}

export type SdkCreateIdentityOptions = {
  displayName: string;
  imessageEnabled: true;
  claimIMessageNumber?: true;
};

export function sdkCreateIdentityOptions(
  dedicatedLine: boolean,
  displayName = "Bro",
): SdkCreateIdentityOptions {
  const opts: SdkCreateIdentityOptions = {
    displayName,
    imessageEnabled: true,
  };
  if (dedicatedLine) opts.claimIMessageNumber = true;
  return opts;
}

export function dedicatedClaimIdempotencyKey(handle: string): string {
  return `bro-dedicated-${handle}`;
}

export type ExistingIdentityUpdate = {
  imessageEnabled?: true;
  claimIMessageNumber?: true;
  idempotencyKey?: string;
};

export function existingIdentityUpdateOptions(opts: {
  dedicatedLine: boolean;
  imessageEnabled: boolean;
  hasDedicatedNumber: boolean;
  handle: string;
}): ExistingIdentityUpdate | undefined {
  const patch: ExistingIdentityUpdate = {};
  if (!opts.imessageEnabled) patch.imessageEnabled = true;
  if (opts.dedicatedLine && !opts.hasDedicatedNumber) {
    patch.claimIMessageNumber = true;
    patch.idempotencyKey = dedicatedClaimIdempotencyKey(opts.handle);
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Shape required by `inkbox.imessages.claimNumber` (unattached inventory). */
export function claimNumberOptions(idempotencyKey: string): {
  idempotencyKey: string;
} {
  return { idempotencyKey };
}

export type DedicatedLineRecord = {
  number: string;
  status?: string;
};

function readNumberish(value: unknown): { number?: unknown; status?: unknown } | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as { number?: unknown; status?: unknown };
}

export function dedicatedLineFromIdentityPayload(
  payload: unknown,
): DedicatedLineRecord | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const rec = payload as {
    imessageNumber?: unknown;
    imessage_number?: unknown;
  };
  return dedicatedLineFromClaimedNumber(
    rec.imessageNumber ?? rec.imessage_number,
  );
}

export function dedicatedLineFromClaimedNumber(
  claimed: unknown,
): DedicatedLineRecord | undefined {
  const raw = readNumberish(claimed);
  if (!raw || typeof raw.number !== "string" || raw.number.length === 0) {
    return undefined;
  }
  const out: DedicatedLineRecord = { number: raw.number };
  if (typeof raw.status === "string" && raw.status.length > 0) {
    out.status = raw.status;
  }
  return out;
}
