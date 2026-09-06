export const OTP_WINDOW_MS = 15 * 60_000;
export const OTP_CHECK_IN_MINUTES = 3;
export const OTP_BODY_CHARS = 2000;
export const OTP_FETCH_BODY_CAP = 3;

export type OtpSource = "bro_mail" | "archive" | "event";

export type OtpCandidate = {
  code: string;
  source: OtpSource;
  from?: string;
  subject?: string;
  atMs?: number;
  confidence: "high" | "medium";
};

export type OtpPick =
  | { status: "found"; hit: OtpCandidate }
  | { status: "ambiguous"; hits: OtpCandidate[] }
  | { status: "missing" };

export type OtpLookupResult = {
  status: "found" | "missing" | "ambiguous";
  code?: string;
  source?: OtpSource;
  hint?: string;
  messages?: number;
};

const OTP_HINT =
  /(?<![а-яёa-z])код(?:у|а|ом)?(?![а-яёa-z])|otp|one[-\s]?time|passcode|верифиц|(?<![а-яёa-z])смс(?![а-яёa-z])|sms|authentication|verification|одноразов|auth code|login code/i;

const KNOWN_SENDERS =
  /wildberries|wb\.ru|ozon|tinkoff|тинькофф|sber|сбер|alfa|альфа|vtb|втб|raiffeisen|райф|clinic|клиник|поликлин|лаборатор|invitro|гемотест|банк|bank/i;

const YEAR = /^(?:19|20)\d{2}$/;
const ORDERISH = /заказ|order|чек|invoice|сумм|руб|₽|шт|промокод|promo\s*code|купон/i;

export function isOtpChallenge(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (
    /needs user input:/i.test(t) &&
    /код|otp|sms|смс|one-time|passcode|подтвержд/i.test(t)
  ) {
    return true;
  }
  return (
    /нужен код|пришли код|one-time|otp|смс[- ]?код|код подтвержд|verification code/i.test(
      t,
    ) && /код|otp|sms|смс/i.test(t)
  );
}

export function looksLikeOtpMail(opts: {
  from?: string;
  subject?: string;
  body?: string;
}): boolean {
  const hay = [opts.from, opts.subject, opts.body].filter(Boolean).join("\n");
  if (!hay.trim()) return false;
  if (OTP_HINT.test(hay)) return true;
  return KNOWN_SENDERS.test(hay) && extractOtpCodes(hay).length > 0;
}

export function snippetHasUsableOtp(subject: string, snippet: string): boolean {
  if (!OTP_HINT.test(subject)) return false;
  return extractOtpCodes(`${subject}\n${snippet}`).some(
    (c) => c.length === 4 || c.length === 6,
  );
}

export function senderFromArchiveContent(content: string): string | undefined {
  const line = /^От:\s*(.+)$/m.exec(content);
  return line?.[1]?.trim() || undefined;
}

export function archiveOtpAllowed(hit: {
  app: string;
  title: string;
  content: string;
}): boolean {
  if (hit.app !== "inkbox" && hit.app !== "gmail") return false;
  const from = senderFromArchiveContent(hit.content) ?? "";
  return KNOWN_SENDERS.test(from);
}

export function shouldIngestInkboxMail(opts: {
  from?: string;
  subject?: string;
  body?: string;
}): boolean {
  return !looksLikeOtpMail(opts);
}

export function extractOtpCodes(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\b(\d{4,8})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const code = m[1]!;
    if (YEAR.test(code)) continue;
    const start = Math.max(0, m.index - 24);
    const end = Math.min(text.length, m.index + code.length + 24);
    const ctx = text.slice(start, end);
    if (ORDERISH.test(ctx) && !OTP_HINT.test(ctx)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export function confidenceFor(opts: {
  from?: string;
  subject?: string;
  body?: string;
  code: string;
}): "high" | "medium" {
  const hay = [opts.from, opts.subject, opts.body].filter(Boolean).join("\n");
  const hinted = OTP_HINT.test(hay);
  const typical = opts.code.length === 4 || opts.code.length === 6;
  if (hinted && typical) return "high";
  if (hinted || (KNOWN_SENDERS.test(hay) && typical)) return "high";
  return "medium";
}

export function candidatesFromMail(
  source: OtpSource,
  mail: { from?: string; subject?: string; body?: string; atMs?: number },
): OtpCandidate[] {
  if (!looksLikeOtpMail(mail)) return [];
  const hay = [mail.subject, mail.body].filter(Boolean).join("\n");
  return extractOtpCodes(hay).map((code) => ({
    code,
    source,
    from: mail.from,
    subject: mail.subject,
    atMs: mail.atMs,
    confidence: confidenceFor({ ...mail, code }),
  }));
}

function rank(h: OtpCandidate, nowMs: number): number {
  const src = h.source === "archive" ? 1 : 2;
  const conf = h.confidence === "high" ? 2 : 1;
  const age =
    h.atMs != null
      ? Math.max(0, OTP_WINDOW_MS - (nowMs - h.atMs)) / OTP_WINDOW_MS
      : 0.5;
  return src * 10 + conf * 3 + age;
}

export function pickOtp(
  hits: readonly OtpCandidate[],
  nowMs = Date.now(),
): OtpPick {
  const fresh = hits.filter(
    (h) => h.atMs != null && nowMs - h.atMs <= OTP_WINDOW_MS,
  );
  if (fresh.length === 0) return { status: "missing" };

  const sorted = [...fresh].sort((a, b) => rank(b, nowMs) - rank(a, nowMs));
  const best = sorted[0]!;
  const rivals = sorted.filter(
    (h) =>
      h.code !== best.code &&
      h.confidence === "high" &&
      best.confidence === "high" &&
      rank(h, nowMs) >= rank(best, nowMs) - 1,
  );
  if (rivals.length > 0) {
    const unique: OtpCandidate[] = [];
    for (const h of [best, ...rivals]) {
      if (!unique.some((u) => u.code === h.code)) unique.push(h);
    }
    if (unique.length > 1) {
      return { status: "ambiguous", hits: unique.slice(0, 3) };
    }
  }
  return { status: "found", hit: best };
}

export function otpSearchQuery(hint?: string): string {
  const base = "код подтверждения OTP one-time verification";
  const h = hint?.trim();
  return (h ? `${base} ${h}` : base).slice(0, 200);
}

export function otpFromEventMail(text: string, nowMs = Date.now()): OtpPick {
  if (!/\[event:mail\]/i.test(text)) return { status: "missing" };
  const from = /from:\s*(.+)/i.exec(text)?.[1]?.trim();
  const subject = /subject:\s*(.+)/i.exec(text)?.[1]?.trim();
  const bodyIdx = text.search(/^body:\s*$/m);
  const body = bodyIdx >= 0 ? text.slice(bodyIdx + 5).trim() : text;
  return pickOtp(
    candidatesFromMail("event", { from, subject, body, atMs: nowMs }),
    nowMs,
  );
}

export function attachOtpToWake(text: string, nowMs = Date.now()): string {
  const otp = otpFromEventMail(text, nowMs);
  if (otp.status !== "found") return text;
  return `${text}\notp: ${otp.hit.code}`;
}

export function formatOtpLookup(result: OtpPick): OtpLookupResult {
  if (result.status === "found") {
    return {
      status: "found",
      code: result.hit.code,
      source: result.hit.source,
      hint: result.hit.subject || result.hit.from,
    };
  }
  if (result.status === "ambiguous") {
    return {
      status: "ambiguous",
      hint: "несколько свежих кодов — спроси в треде",
    };
  }
  return { status: "missing", hint: "письма нет — спроси в треде" };
}
