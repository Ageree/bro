/**
 * Redact secret-shaped substrings from free text before it reaches a model,
 * a log line, a chat message — or, since S1, the browser vendor. This is a
 * last-resort net, not the primary guard: it catches a card/CVV/password that
 * leaked out of band (a page dump, a `.value` read, a copy-pasted receipt,
 * a human typing their site password into iMessage) even when nothing
 * upstream recognized it as vault content.
 */

// 13-19 digits total, optionally separated by a single space or dash between
// each digit (covers "4111 1111 1111 1111" and "2200-1234-5678-9012").
//
// S1 — this is only a CANDIDATE now, not a verdict. A marketplace tracking
// number has exactly the same shape, so the blind rule used to turn «проверь
// заказ 46000123456789» into «проверь заказ [card]» and delete the errand's
// own subject; that is why `agent/lib/browseruse.ts` deliberately never
// scrubbed the task as a whole. `looksLikeCardNumber` below decides, so the
// rule became safe to run over the human's verbatim line on its way out to
// the vendor.
const PAN_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

// The one shape nobody writes a tracking number in: four groups of four.
const CARD_GROUPS = /^\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}$/;

/** Luhn checksum — every real PAN passes it, an arbitrary digit run has ~1/10
 *  odds of doing so by accident. */
function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    let n = d;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Is this digit run a card number rather than a tracking / order / account
 * number? Luhn is the real test; the four-groups-of-four spelling is kept as
 * a second gate because a human (or a receipt) writing «2200-1234-5678-9012»
 * plainly means a card even when the made-up digits do not check out.
 */
export function looksLikeCardNumber(run: string): boolean {
  const digits = run.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  return luhnOk(digits) || CARD_GROUPS.test(run.trim());
}

// "cvc: 123" / "CVV2 1234" / "cvv1234" — keep the label, drop the digits.
const CVC_RE = /\b(cvc2?|cvv2?)\b(\s*[:=]?\s*)(\d{3,4})\b/gi;

// Password labels, with the Russian ones allowed a short inflection tail
// («пароля», «паролем»). «пасс» carries an explicit end-boundary below so
// «пассажир» / «пассажира» can never match it.
const PW_LABEL = String.raw`(?:password|passphrase|парол[\p{L}]{0,3}|пассворд|пасс)`;

// "password: hunter2" / "пароль: хантер2" — keep the label, drop the value.
// Plain `\b` is ASCII-only in JS without the `u` flag, so `\bпароль\b` never
// matched Cyrillic (both neighbors of «п»/«ь» count as "non-word" to `\b`) —
// unicode-aware lookarounds fix that. A separator is still required so
// ordinary prose ("пароль не подошёл") is not mistaken for a "label: value"
// pair.
//
// S1 — the separator no longer has to sit IMMEDIATELY after the label. It
// used to, and «пароль от озона: Hunter2024» therefore sailed through
// untouched (the label is followed by « от», not by «:»), which is exactly
// the shape a person types in chat. The second branch tolerates a short run
// of words before the «:»/«=». That gap deliberately admits no digit, no
// comma and no sentence-ending punctuation, and is capped at 20 chars, so a
// «:» belonging to a later clause cannot be reached and «пароль не подошёл,
// зайди на сайт: …» is left alone.
const PASSWORD_RE = new RegExp(
  String.raw`(?<![\p{L}\d])(${PW_LABEL})(?![\p{L}\d])` +
    String.raw`(\s*[:=—–-]\s*|[^\d\n:=,;!?]{0,20}[:=]\s*)(\S+)`,
  "giu",
);

// S1 — «логин vasya пароль Hunter2024»: no separator anywhere, so the rule
// above cannot see it. A label followed by a token that is ITSELF
// secret-shaped (letters AND digits, 6+ chars) is a credential whatever the
// punctuation; ordinary prose after the label («пароль не подошёл») has no
// such token, so this stays quiet.
const PASSWORD_BARE_RE = new RegExp(
  String.raw`(?<![\p{L}\d])(${PW_LABEL})(?![\p{L}\d])(\s+)((?=\S*\p{L})(?=\S*\d)\S{6,})`,
  "giu",
);

export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(CVC_RE, (_m, label: string, sep: string) => `${label}${sep}[cvv]`);
  out = out.replace(
    PASSWORD_RE,
    (_m, label: string, sep: string) => `${label}${sep}[password]`,
  );
  out = out.replace(
    PASSWORD_BARE_RE,
    (_m, label: string, sep: string) => `${label}${sep}[password]`,
  );
  out = out.replace(PAN_RE, (m: string) => (looksLikeCardNumber(m) ? "[card]" : m));
  return out;
}
