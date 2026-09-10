export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const START_COOLDOWN_MS = 45 * 1000;
export const MAX_VERIFY_ATTEMPTS = 5;

export type LoginStartKind = "unknown" | "unbound" | "cooldown" | "ok";

export type BoundTenant = {
  phoneE164?: string;
  inkboxConversationId?: string;
  photonConversationId?: string;
  inkboxHandle?: string;
  inkboxIdentityId?: string;
};

export function loginStartDecision(opts: {
  tenant: BoundTenant | null;
  lastChallengeAt?: number;
  now: number;
  cooldownMs?: number;
}): LoginStartKind {
  const t = opts.tenant;
  if (!t?.inkboxHandle) return "unknown";
  const chatId = t.photonConversationId || t.inkboxConversationId;
  if (!t.phoneE164 || !chatId || !t.inkboxIdentityId) {
    return "unbound";
  }
  const cool = opts.cooldownMs ?? START_COOLDOWN_MS;
  if (
    opts.lastChallengeAt !== undefined &&
    opts.now - opts.lastChallengeAt < cool
  ) {
    return "cooldown";
  }
  return "ok";
}

export type LoginVerifyKind =
  | { kind: "ok" }
  | { kind: "expired" }
  | { kind: "locked" }
  | { kind: "wrong"; attemptsLeft: number };

export function loginVerifyDecision(opts: {
  now: number;
  expiresAt: number;
  attempts: number;
  codeMatch: boolean;
  maxAttempts?: number;
}): LoginVerifyKind {
  const max = opts.maxAttempts ?? MAX_VERIFY_ATTEMPTS;
  if (opts.now >= opts.expiresAt) return { kind: "expired" };
  if (opts.attempts >= max) return { kind: "locked" };
  if (opts.codeMatch) return { kind: "ok" };
  return { kind: "wrong", attemptsLeft: Math.max(0, max - opts.attempts - 1) };
}

export function sessionExpiry(now: number, ttlMs = SESSION_TTL_MS): number {
  return now + ttlMs;
}

export function challengeExpiry(now: number, ttlMs = CHALLENGE_TTL_MS): number {
  return now + ttlMs;
}

export function sessionLive(expiresAt: number, now: number): boolean {
  return expiresAt > now;
}

export type PlanKind = "free" | "paid";

export type BrowserJobSnapshot = {
  status: string;
  label: string;
  task?: string;
  liveUrl?: string;
  startedAt?: number;
};

export type ComputerSnapshot = {
  state: string;
  lastActiveAt?: number;
};

export type ChatgptSnapshot = {
  status: "none" | "pending" | "connected" | "quarantined";
  planType?: string;
  email?: string;
};

export type PaymentRow = {
  createdAt: number;
  amountRub: number;
  status: "pending" | "succeeded" | "canceled";
};

/**
 * Cabinet GET /me snapshot.
 * `memories` is oldest-first, newest-last (same as wake recall).
 * Capped at WAKE_LINES, keeping the newest lines. Empty if the phone is unbound.
 */
export type CabinetSnapshot = {
  handle: string;
  phoneBound: boolean;
  phoneLast4?: string;
  plan: PlanKind;
  paidUntil?: number;
  msgsUsed: number;
  msgsAllowance: number;
  msgsDayKey: string;
  browserUsed: number;
  browserAllowance: number;
  browserMonthKey: string;
  payments: PaymentRow[];
  browserProfileId?: string;
  browserCookieDomains: string[];
  browserProfileStatus: "missing" | "empty" | "synced";
  memories: string[];
  tz?: string;
  browserJob: BrowserJobSnapshot;
  computer: ComputerSnapshot;
  chatgpt: ChatgptSnapshot;
};

/** Accept only a stored bro-xxxxxxxx handle — typing one is not the login path. */
export function storedHandle(raw: string | null | undefined): string | null {
  const h = (raw ?? "").trim();
  return /^bro-[a-z0-9]{8}$/.test(h) ? h : null;
}

/** Newest-first DB rows → oldest-first snapshot, newest last. Cap is WAKE_LINES. */
export function memoriesForSnapshot(
  newestFirst: readonly string[],
  cap: number,
): string[] {
  return newestFirst.slice(0, cap).slice().reverse();
}

export function phoneLast4(phoneE164: string | undefined): string | undefined {
  if (!phoneE164 || phoneE164.length < 4) return undefined;
  return phoneE164.slice(-4);
}

export function paymentsOwnedBy<T extends { tenantId: string }>(
  tenantId: string,
  rows: T[],
): T[] {
  return rows.filter((r) => r.tenantId === tenantId);
}

export function buildSnapshot(opts: {
  handle: string;
  phoneE164?: string;
  paid: boolean;
  paidUntil?: number;
  msgsUsed: number;
  msgsAllowance: number;
  msgsDayKey: string;
  browserUsed: number;
  browserAllowance: number;
  browserMonthKey: string;
  payments: PaymentRow[];
  browserProfileId?: string;
  browserCookieDomains?: string[];
  browserProfileStatus?: "missing" | "empty" | "synced";
  memories?: string[];
  tz?: string;
  browserJob?: BrowserJobSnapshot;
  computer?: ComputerSnapshot;
  chatgpt?: ChatgptSnapshot;
}): CabinetSnapshot {
  const phoneBound = Boolean(opts.phoneE164);
  const last4 = phoneLast4(opts.phoneE164);
  return {
    handle: opts.handle,
    phoneBound,
    ...(last4 ? { phoneLast4: last4 } : {}),
    plan: opts.paid ? "paid" : "free",
    ...(opts.paid && opts.paidUntil !== undefined
      ? { paidUntil: opts.paidUntil }
      : {}),
    msgsUsed: opts.msgsUsed,
    msgsAllowance: opts.msgsAllowance,
    msgsDayKey: opts.msgsDayKey,
    browserUsed: opts.browserUsed,
    browserAllowance: opts.browserAllowance,
    browserMonthKey: opts.browserMonthKey,
    payments: opts.payments,
    ...(opts.browserProfileId ? { browserProfileId: opts.browserProfileId } : {}),
    browserCookieDomains: opts.browserCookieDomains ?? [],
    browserProfileStatus: opts.browserProfileStatus ?? "missing",
    memories: opts.memories ?? [],
    ...(opts.tz ? { tz: opts.tz } : {}),
    browserJob: opts.browserJob ?? { status: "", label: "Сейчас ничего не делает" },
    computer: opts.computer ?? { state: "none" },
    chatgpt: opts.chatgpt ?? { status: "none" },
  };
}

export function paymentApplyDecision(alreadyRecorded: boolean): "skip" | "apply" {
  return alreadyRecorded ? "skip" : "apply";
}

export async function sha256hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function newSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newLoginCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
  return n.toString().padStart(6, "0");
}
