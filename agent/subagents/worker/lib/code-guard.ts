/**
 * Static guard for `execute_playwright_code`.
 *
 * `fill_from_vault` types a real secret (card number, CVC, password, cookie)
 * into the live DOM over CDP — there is no code-side redaction of the value
 * itself once it is there. `execute_playwright_code` runs arbitrary
 * Playwright with full `page`/`context`/`browser` access, so nothing but a
 * prompt instruction stopped a program from reading that value back out
 * (`el.value`, `context.cookies()`, ...) and returning it in `result`. This
 * module recognizes the read-back shapes and, combined with the per-session
 * flag below, refuses them outright once a vault fill has happened.
 */

const RISKY_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  {
    re: /\.value\b/,
    reason: "код читает `.value` — так можно прочитать значение, введённое из сейфа",
  },
  {
    re: /\binputValue\s*\(/,
    reason:
      "`inputValue(...)` возвращает значение поля — после ввода из сейфа так читать нельзя",
  },
  {
    re: /context\s*\.\s*cookies\s*\(/,
    reason: "`context.cookies()` может вернуть секретные куки сессии",
  },
  {
    re: /document\s*\.\s*cookie/,
    reason: "`document.cookie` — секрет, читать нельзя",
  },
  {
    re: /vaultSecret/i,
    reason: "код обращается к `vaultSecret` — так помечено поле с секретом из сейфа",
  },
  {
    re: /data-vault-secret/i,
    reason:
      "код обращается к `data-vault-secret` — так помечено поле с секретом из сейфа",
  },
  {
    re: /\blocalStorage\b/,
    reason: "`localStorage` может хранить секреты сайта — читать нельзя",
  },
  {
    re: /\bsessionStorage\b/,
    reason: "`sessionStorage` может хранить секреты сайта — читать нельзя",
  },
  {
    re: /evaluate\s*\([^)]*\bvalue\b/is,
    reason:
      "`evaluate(...)` читает `value` внутри страницы — так можно вытащить введённый секрет",
  },
];

/** Returns a Russian reason the code is risky, or null when it looks safe. */
export function playwrightCodeRisk(code: string): string | null {
  for (const { re, reason } of RISKY_PATTERNS) {
    if (re.test(code)) return reason;
  }
  return null;
}

// Per-worker-session flag: has `fill_from_vault` run in this eve session?
// Keyed by `ctx.session.id`, which is stable across a worker's resumptions
// within one assignment but never shared across tenants or sessions.
const vaultFilledSessions = new Set<string>();

export function markVaultFilled(sessionKey: string): void {
  vaultFilledSessions.add(sessionKey);
}

export function hasVaultFilled(sessionKey: string): boolean {
  return vaultFilledSessions.has(sessionKey);
}

/** Test-only: forget a session's vault-filled flag. */
export function forgetVaultFilled(sessionKey: string): void {
  vaultFilledSessions.delete(sessionKey);
}

export type CodeGuardVerdict =
  | { blocked: true; reason: string }
  | { blocked: false; warning?: string };

/**
 * Decide whether `execute_playwright_code` may run this program for this
 * worker session. Before any vault fill, a risky pattern is only a warning
 * (the model may have a legitimate reason, e.g. reading a non-secret field);
 * after a vault fill, the same pattern is refused outright.
 */
export function checkPlaywrightCode(
  code: string,
  sessionKey: string,
): CodeGuardVerdict {
  const risk = playwrightCodeRisk(code);
  if (!risk) return { blocked: false };
  if (hasVaultFilled(sessionKey)) {
    return {
      blocked: true,
      reason: `после ввода из сейфа значения полей читать нельзя: ${risk}`,
    };
  }
  return { blocked: false, warning: risk };
}
