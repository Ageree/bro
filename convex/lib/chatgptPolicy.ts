/** Pure ChatGPT / Codex login policy. No I/O. */

export const CHATGPT_REFRESH_MARGIN_MS = 120_000;

export function requireTenantId<T extends string>(tenantId: T): T {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("tenantId required");
  }
  return tenantId;
}

export function requirePhone(phoneE164: string): string {
  const phone = phoneE164.trim();
  if (!phone) throw new Error("phoneE164 required");
  return phone;
}

export function requireVersion(version: number): number {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("version must be a non-negative integer");
  }
  return version;
}

export type ChatgptLoginStatus =
  | "pending"
  | "done"
  | "expired"
  | "failed";

/** Legacy device-login rows used `authorized`; writers now store `done`. */
export type ChatgptLoginStatusInput = ChatgptLoginStatus | "authorized";

export type ChatgptSnapshotStatus = "none" | "pending" | "connected" | "quarantined";

function requireFinite(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

/** Sleep between device-code polls. `slowDown` is extra seconds (RFC 8628). */
export function devicePollSleepMs(interval: number, slowDown?: number): number {
  const seconds = requireFinite("interval", interval);
  if (seconds < 0) throw new Error("interval must be >= 0");
  let extra = 0;
  if (slowDown !== undefined) {
    extra = requireFinite("slowDown", slowDown);
    if (extra < 0) throw new Error("slowDown must be >= 0");
  }
  return Math.max(1, seconds + extra) * 1000;
}

/** Refresh when `now` is within `marginMs` of access expiry. */
export function shouldRefresh(
  accessExpiresAt: number,
  now: number,
  marginMs: number = CHATGPT_REFRESH_MARGIN_MS,
): boolean {
  const expires = requireFinite("accessExpiresAt", accessExpiresAt);
  const at = requireFinite("now", now);
  const margin = requireFinite("marginMs", marginMs);
  if (margin < 0) throw new Error("marginMs must be >= 0");
  return at + margin >= expires;
}

export function loginExpired(expiresAt: number, now: number): boolean {
  return requireFinite("now", now) >= requireFinite("expiresAt", expiresAt);
}

export function nextLoginStatus(input: {
  status: ChatgptLoginStatusInput;
  expiresAt: number;
  now: number;
}): ChatgptLoginStatus {
  if (typeof input !== "object" || input === null) {
    throw new Error("nextLoginStatus input required");
  }
  const raw = input.status;
  if (
    raw !== "pending" &&
    raw !== "authorized" &&
    raw !== "done" &&
    raw !== "expired" &&
    raw !== "failed"
  ) {
    throw new Error("status must be a ChatGPT login status");
  }
  const status: ChatgptLoginStatus = raw === "authorized" ? "done" : raw;
  if (status === "pending" && loginExpired(input.expiresAt, input.now)) {
    return "expired";
  }
  return status;
}

/** Group turns never use a person's Plus/Codex quota. */
export function groupUsesOpenRouter(isGroup: boolean): boolean {
  if (typeof isGroup !== "boolean") {
    throw new Error("isGroup must be a boolean");
  }
  return isGroup;
}

export function snapshotStatus(input: {
  hasAccount: boolean;
  quarantinedAt?: number | null;
  loginStatus?: ChatgptLoginStatusInput;
}): ChatgptSnapshotStatus {
  if (typeof input !== "object" || input === null) {
    throw new Error("snapshotStatus input required");
  }
  if (typeof input.hasAccount !== "boolean") {
    throw new Error("hasAccount must be a boolean");
  }
  if (input.quarantinedAt != null) {
    requireFinite("quarantinedAt", input.quarantinedAt);
    return "quarantined";
  }
  if (input.hasAccount) return "connected";
  if (input.loginStatus === "pending") return "pending";
  return "none";
}
