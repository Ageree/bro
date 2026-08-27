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

/** IdentityIMessageNumber is `{ id, number, type }`. Status lives on IMessageNumber. */
export type DedicatedLineRecord = {
  number: string;
  id?: string;
  status?: string;
};

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Number attached to an identity. Matches `IdentityIMessageNumber` /
 * `RawIdentityIMessageNumber` (`id`, `number`, `type` only). Status on the
 * embed is ignored — `parseIdentityIMessageNumber` drops it.
 */
export function dedicatedLineFromIdentityPayload(
  payload: unknown,
): DedicatedLineRecord | undefined {
  const rec = readObject(payload);
  if (!rec) return undefined;
  const embed = readObject(rec.imessageNumber) ?? readObject(rec.imessage_number);
  if (!embed) return undefined;
  const number = readString(embed.number);
  if (!number) return undefined;
  const id = readString(embed.id);
  return id ? { number, id } : { number };
}

type InventoryRow = {
  id?: string;
  number?: string;
  status?: string;
  agentIdentityId?: string;
  agentHandle?: string;
};

/**
 * One `IMessageNumber` from `inkbox.imessages.listNumbers()` /
 * `claimNumber()`, or the REST `/imessage/numbers` row
 * (`RawIMessageNumber`: `status`, `agent_identity_id`, `agent_handle`).
 */
export function dedicatedLineFromInventoryNumber(
  claimed: unknown,
): DedicatedLineRecord | undefined {
  const row = readInventoryRow(claimed);
  if (!row?.number) return undefined;
  const out: DedicatedLineRecord = { number: row.number };
  if (row.id) out.id = row.id;
  if (row.status) out.status = row.status;
  return out;
}

function readInventoryRow(value: unknown): InventoryRow | undefined {
  const r = readObject(value);
  if (!r) return undefined;
  return {
    id: readString(r.id),
    number: readString(r.number),
    status: readString(r.status),
    agentIdentityId:
      readString(r.agentIdentityId) ?? readString(r.agent_identity_id),
    agentHandle: readString(r.agentHandle) ?? readString(r.agent_handle),
  };
}

function inventoryRows(inventory: unknown): InventoryRow[] {
  if (!Array.isArray(inventory)) return [];
  const rows: InventoryRow[] = [];
  for (const item of inventory) {
    const row = readInventoryRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Attach `IMessageNumber.status` from inventory onto an identity line.
 * Match by number, inventory id, `agentIdentityId`, or `agentHandle`.
 */
export function dedicatedLineFromInventory(
  identityLine: DedicatedLineRecord | undefined,
  inventory: unknown,
  match: { identityId?: string; handle?: string },
): DedicatedLineRecord | undefined {
  if (!identityLine) return undefined;
  const hit = inventoryRows(inventory).find((row) => {
    if (identityLine.number && row.number === identityLine.number) return true;
    if (identityLine.id && row.id === identityLine.id) return true;
    if (match.identityId && row.agentIdentityId === match.identityId) return true;
    if (match.handle && row.agentHandle === match.handle) return true;
    return false;
  });
  if (hit?.status) return { ...identityLine, status: hit.status };
  return identityLine;
}
