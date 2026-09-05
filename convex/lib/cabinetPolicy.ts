export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const START_COOLDOWN_MS = 45 * 1000;
export const MAX_VERIFY_ATTEMPTS = 5;

export type LoginStartKind = "unknown" | "unbound" | "cooldown" | "ok";

export type BoundTenant = {
  phoneE164?: string;
  inkboxConversationId?: string;
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
  if (!t.phoneE164 || !t.inkboxConversationId || !t.inkboxIdentityId) {
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

export type PaymentRow = {
  createdAt: number;
  amountRub: number;
  status: "pending" | "succeeded" | "canceled";
};

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
};

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

export type LoginIdentifier =
  | { kind: "handle"; handle: string }
  | { kind: "phone"; phoneE164: string };

export function parseLoginIdentifier(raw: string): LoginIdentifier | null {
  const trimmed = raw.trim();
  if (/^bro-[a-z0-9]{8}$/i.test(trimmed)) {
    return { kind: "handle", handle: trimmed.toLowerCase() };
  }
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("8")) {
    return { kind: "phone", phoneE164: `+7${digits.slice(1)}` };
  }
  if (digits.length === 11 && digits.startsWith("7")) {
    return { kind: "phone", phoneE164: `+${digits}` };
  }
  if (digits.length === 10 && digits.startsWith("9")) {
    return { kind: "phone", phoneE164: `+7${digits}` };
  }
  if (hadPlus && digits.length >= 10 && digits.length <= 15) {
    return { kind: "phone", phoneE164: `+${digits}` };
  }
  return null;
}

export function loginLinkFor(
  base: string | undefined,
  handle: string,
  code: string,
): string | undefined {
  if (!base) return undefined;
  const trimmedBase = base.replace(/\/+$/, "");
  if (!trimmedBase) return undefined;
  return `${trimmedBase}/cabinet.html#login=${handle}.${code}`;
}

export function loginCodeText(code: string, link: string | undefined): string {
  const first = `Код входа в кабинет bro: ${code}`;
  if (!link) return first;
  return `${first}\nИли просто нажми: ${link}`;
}
