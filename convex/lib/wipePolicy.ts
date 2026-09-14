export type WipeRefuse = "invalid" | "missing" | "mismatch";

/** Same rule as `isValidHandle` in accessPolicy — kept local so Node checks can import this file. */
const HANDLE = /^bro-[a-z0-9]{8}$/;

export type WipeDecision = { ok: true } | { ok: false; reason: WipeRefuse };

/** E.164-ish: plus, then 8–15 digits. Rejects empty and the obvious junk. */
export function isWipePhone(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

/**
 * Wipe only when phone and handle name the same existing tenant.
 * Missing handle, swapped pair, or two different rows → refuse. Never guess.
 */
export function wipeDecision(input: {
  phoneE164: string;
  handle: string;
  tenant: { _id: string; phoneE164?: string; inkboxHandle?: string } | null;
  handleTenantId?: string | null;
}): WipeDecision {
  const phone = input.phoneE164.trim();
  const handle = input.handle.trim();
  if (!isWipePhone(phone) || !HANDLE.test(handle)) {
    return { ok: false, reason: "invalid" };
  }
  if (!input.tenant) return { ok: false, reason: "missing" };
  if (
    input.handleTenantId != null &&
    input.handleTenantId !== input.tenant._id
  ) {
    return { ok: false, reason: "mismatch" };
  }
  if (input.tenant.phoneE164 !== phone || input.tenant.inkboxHandle !== handle) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

export function wipeRefuseMessage(reason: WipeRefuse): string {
  if (reason === "invalid") return "phone and handle are not a valid pair";
  if (reason === "missing") return "no tenant for that phone";
  return "phone and handle do not belong to the same tenant";
}
