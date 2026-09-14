/**
 * Redact secret-shaped substrings from free text before it reaches a model,
 * a log line, or a chat message. This is a last-resort net, not the primary
 * guard: it catches a card/CVV/password that leaked out of band (a page
 * dump, a `.value` read, a copy-pasted receipt) even when nothing upstream
 * recognized it as vault content.
 */

// 13-19 digits total, optionally separated by a single space or dash between
// each digit (covers "4111 1111 1111 1111" and "2200-1234-5678-9012").
const PAN_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

// "cvc: 123" / "CVV2 1234" / "cvv1234" — keep the label, drop the digits.
const CVC_RE = /\b(cvc2?|cvv2?)\b(\s*[:=]?\s*)(\d{3,4})\b/gi;

// "password: hunter2" / "пароль: хантер2" — keep the label, drop the value.
// Plain `\b` is ASCII-only in JS without the `u` flag, so `\bпароль\b` never
// matched Cyrillic (both neighbors of «п»/«ь» count as "non-word" to `\b`) —
// unicode-aware lookarounds fix that. The separator is required so ordinary
// prose ("пароль не подошёл") is not mistaken for a "label: value" pair.
const PASSWORD_RE =
  /(?<![\p{L}\d])(password|пароль)(?![\p{L}\d])(\s*[:=—-]\s*)(\S+)/giu;

export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(CVC_RE, (_m, label: string, sep: string) => `${label}${sep}[cvv]`);
  out = out.replace(
    PASSWORD_RE,
    (_m, label: string, sep: string) => `${label}${sep}[password]`,
  );
  out = out.replace(PAN_RE, "[card]");
  return out;
}
