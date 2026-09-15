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

// A hint like "wildberries" or "вб" often doesn't literally appear in the
// candidate's `from`/`subject` (real WB mail comes from wb.ru); a short
// alias table covers the common abbreviations without hand-listing every
// merchant twice.
const HINT_ALIASES: Record<string, RegExp> = {
  wb: /wildberries|wb\.ru/i,
  вб: /wildberries|wb\.ru/i,
  wildberries: /wildberries|wb\.ru/i,
  ozon: /ozon/i,
  озон: /ozon/i,
  tinkoff: /tinkoff|тинькофф/i,
  тинькофф: /tinkoff|тинькофф/i,
  sber: /sber|сбер/i,
  сбер: /sber|сбер/i,
};

function candidateHay(h: OtpCandidate): string {
  return `${h.from ?? ""} ${h.subject ?? ""}`;
}

/** Does this candidate's sender/subject match the caller's merchant hint? */
function matchesHint(h: OtpCandidate, hint: string): boolean {
  const hay = candidateHay(h).toLowerCase();
  const key = hint.trim().toLowerCase();
  if (!key) return false;
  if (hay.includes(key)) return true;
  const alias = HINT_ALIASES[key];
  return alias ? alias.test(hay) : false;
}

/** Is this candidate clearly from *some* recognized merchant/bank/clinic? */
function isKnownSender(h: OtpCandidate): boolean {
  return KNOWN_SENDERS.test(candidateHay(h));
}

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
  // Normalize spaced digit groups before extraction
  let normalized = text;
  normalized = normalized.replace(/\b(\d{3})[  ](\d{3})\b/g, "$1$2");
  normalized = normalized.replace(/\b(\d{2})[  ](\d{2})[  ](\d{2})\b/g, "$1$2$3");
  normalized = normalized.replace(/\b(\d{4})[  ](\d{4})\b/g, "$1$2");
  // Note: \b(\d{1})[  ](\d{3})\b is deliberately NOT joined to avoid matching prices like "1 990"
  const re = /\b(\d{4,8})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized))) {
    const code = m[1]!;
    if (YEAR.test(code)) continue;
    const start = Math.max(0, m.index - 24);
    const end = Math.min(normalized.length, m.index + code.length + 24);
    const ctx = normalized.slice(start, end);
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

function rank(h: OtpCandidate, nowMs: number, hint?: string): number {
  const src = h.source === "archive" ? 1 : 2;
  const conf = h.confidence === "high" ? 2 : 1;
  const age =
    h.atMs != null
      ? Math.max(0, OTP_WINDOW_MS - (nowMs - h.atMs)) / OTP_WINDOW_MS
      : 0.5;
  let hintAdj = 0;
  if (hint) {
    if (matchesHint(h, hint)) hintAdj = 3;
    else if (isKnownSender(h)) hintAdj = -3;
  }
  return src * 10 + conf * 3 + age + hintAdj;
}

function dedupeByCode(hits: readonly OtpCandidate[]): OtpCandidate[] {
  const unique: OtpCandidate[] = [];
  for (const h of hits) {
    if (!unique.some((u) => u.code === h.code)) unique.push(h);
  }
  return unique;
}

/**
 * Rank fresh OTP candidates and pick the one the caller almost certainly
 * wants. `hint` (usually a merchant name the coordinator already knows it's
 * waiting on, e.g. "wildberries") boosts a matching sender and demotes a
 * candidate that clearly belongs to a *different* known sender — without a
 * hint match, a same-window bank code could otherwise outrank the merchant
 * code root actually needs (Finding A4 #6).
 */
export function pickOtp(
  hits: readonly OtpCandidate[],
  nowMs = Date.now(),
  hint?: string,
): OtpPick {
  const fresh = hits.filter(
    (h) => h.atMs != null && nowMs - h.atMs <= OTP_WINDOW_MS,
  );
  if (fresh.length === 0) return { status: "missing" };

  const sorted = [...fresh].sort(
    (a, b) => rank(b, nowMs, hint) - rank(a, nowMs, hint),
  );
  const best = sorted[0]!;
  const rivals = sorted.filter(
    (h) =>
      h.code !== best.code &&
      h.confidence === "high" &&
      best.confidence === "high" &&
      rank(h, nowMs, hint) >= rank(best, nowMs, hint) - 1,
  );
  if (rivals.length > 0) {
    const unique = dedupeByCode([best, ...rivals]);
    if (unique.length > 1) {
      return { status: "ambiguous", hits: unique.slice(0, 3) };
    }
  }
  if (hint && !matchesHint(best, hint)) {
    const hintedAlt = fresh.find((h) => matchesHint(h, hint));
    if (hintedAlt) {
      return {
        status: "ambiguous",
        hits: dedupeByCode([hintedAlt, best]).slice(0, 3),
      };
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
