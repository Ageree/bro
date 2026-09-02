/**
 * Browser Use Cloud Chrome cookie sync.
 * Official flow: https://docs.browser-use.com/cloud/guides/profile-sync
 * Announced by Gregor Zunic (@gregpr07): sync local Chrome cookies so the
 * agent stays logged in without ever seeing passwords.
 */

export const PROFILE_SYNC_SCRIPT = "https://browser-use.com/profile.sh";
export const PROFILE_SYNC_DOCS = "https://docs.browser-use.com/cloud/guides/profile-sync";

const PROFILE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isBrowserProfileId(raw: string | undefined): boolean {
  const id = raw?.trim() ?? "";
  return PROFILE_ID_RE.test(id);
}

export function normalizeBrowserProfileId(
  raw: string | undefined,
): string | undefined {
  const id = raw?.trim() ?? "";
  return isBrowserProfileId(id) ? id : undefined;
}

/** Official helper. Never embed a real API key — the human supplies theirs. */
export function profileSyncCommand(apiKey = "bu_…"): string {
  const key = apiKey.trim() || "bu_…";
  return `export BROWSER_USE_API_KEY=${key} && curl -fsSL ${PROFILE_SYNC_SCRIPT} | sh`;
}

export function profileSyncStatus(opts: {
  profileId?: string;
  cookieDomains?: readonly string[];
}): "missing" | "empty" | "synced" {
  if (!normalizeBrowserProfileId(opts.profileId)) return "missing";
  return (opts.cookieDomains?.length ?? 0) > 0 ? "synced" : "empty";
}

export function createProfileSetupUrl(baseUrl: string): string {
  const url = new URL("/cabinet.html", baseUrl.replace(/\/$/, "") + "/");
  url.hash = "chrome";
  return url.toString();
}

export function pickCookieDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const host = item.trim();
    if (!host || host.length > 253) continue;
    if (!out.includes(host)) out.push(host);
    if (out.length >= 40) break;
  }
  return out;
}
