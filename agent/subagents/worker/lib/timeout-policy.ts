/**
 * Kernel cannot extend a running browser's `timeout_seconds` after creation
 * (`BrowserUpdateParams` has no timeout field at all) — the only lever is
 * picking a generous default up front. The 15-minute floor is fine for a
 * quick read-only lookup, but an OTP wait (mailbox lookup, a slow human, a
 * slow bank) routinely exceeds it, and root then resumes a worker whose
 * Kernel session is already gone. Default to 45 minutes whenever the
 * assignment is plausibly going to need a saved login, a checkout, or the
 * model explicitly flagged it as long-lived.
 */

export const BROWSER_TIMEOUT_FLOOR_SECONDS = 15 * 60;
export const BROWSER_TIMEOUT_LONG_LIVED_SECONDS = 45 * 60;

// Host or path segment that usually means "this page needs a saved login,
// a checkout, or 2FA" — login walls, passport/SSO pages, and payment/cart
// flows are exactly the pages an OTP or profile-sync wait can stall on.
const LOGIN_OR_CHECKOUT_RE =
  /(?:^|[.\-/])(?:login|signin|sign-in|log-?in|auth|passport|sso|checkout|payment|pay|oplata|kassa|cart|korzina|oformlenie)(?:[.\-/?]|$)/i;

export function looksLikeLoginOrCheckoutUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    LOGIN_OR_CHECKOUT_RE.test(parsed.hostname) ||
    LOGIN_OR_CHECKOUT_RE.test(parsed.pathname)
  );
}

export function defaultBrowserTimeoutSeconds(opts: {
  saveChanges?: boolean;
  startUrl?: string;
  longLived?: boolean;
}): number {
  if (opts.longLived) return BROWSER_TIMEOUT_LONG_LIVED_SECONDS;
  if (opts.saveChanges) return BROWSER_TIMEOUT_LONG_LIVED_SECONDS;
  if (looksLikeLoginOrCheckoutUrl(opts.startUrl)) {
    return BROWSER_TIMEOUT_LONG_LIVED_SECONDS;
  }
  return BROWSER_TIMEOUT_FLOOR_SECONDS;
}
