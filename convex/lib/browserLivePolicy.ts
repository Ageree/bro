/**
 * Browser Use Cloud v4 live preview lives on run events, not GET /runs.
 * https://docs.browser-use.com/cloud/browser/live-preview
 * `browser.ready` → data.live_view_url (also camelCase / legacy liveUrl).
 *
 * Ready fires when the session exists, usually about:blank or the Cloud
 * home — not the site login. Do not text that URL until the login page
 * is showing. v4 POST /runs has no startUrl.
 */

export const BROWSER_READY_TYPES = new Set(["browser.ready", "browser_ready"]);

/** How long profile_setup waits for the live URL to exist at all. */
export const LOGIN_LIVE_WAIT_MS = 25_000;

/** How long profile_setup waits for the site login page after ready. */
export const LOGIN_LANDING_WAIT_MS = 45_000;

const LIVE_URL_KEYS = new Set([
  "live_view_url",
  "liveViewUrl",
  "liveUrl",
  "live_url",
]);

const IGNORE_EVENT_TYPES = new Set([
  "run.created",
  "run_created",
  "run.queued",
  "run_queued",
  "run.started",
  "run_started",
  "browser.ready",
  "browser_ready",
]);

const SKIP_URL_KEYS = new Set([
  ...LIVE_URL_KEYS,
  "task",
  "prompt",
  "instruction",
  "instructions",
  "cdpUrl",
  "cdp_url",
  "recordingUrl",
  "recording_url",
]);

const PREVIEW_HOSTS = new Set([
  "live.browser-use.com",
  "cloud.browser-use.com",
  "api.browser-use.com",
  "browser-use.com",
  "www.browser-use.com",
]);

const IDENTITY_HOST_PREFIXES = [
  "passport",
  "id",
  "auth",
  "login",
  "account",
  "accounts",
  "oauth",
  "sso",
  "signin",
  "signup",
  "identity",
  "idp",
];

const NAV_TOOL =
  /^(browser_)?(navigate|goto|open_url|go_to_url|open)$/i;

const HREF_RE = /https?:\/\/[^\s"'<>\\]+/gi;

export function isLiveViewUrl(raw: string | undefined): boolean {
  const text = raw?.trim() ?? "";
  if (!text) return false;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function pickLiveUrl(raw: unknown, depth = 0): string | undefined {
  if (typeof raw === "string") return isLiveViewUrl(raw) ? raw.trim() : undefined;
  if (!raw || typeof raw !== "object" || depth > 4) return undefined;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = pickLiveUrl(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    if (LIVE_URL_KEYS.has(key) && typeof value === "string" && isLiveViewUrl(value)) {
      return value.trim();
    }
  }
  for (const nest of ["data", "browser", "session", "payload"]) {
    if (nest in rec) {
      const found = pickLiveUrl(rec[nest], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function eventsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec.events)) return rec.events;
  }
  return [];
}

function eventType(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  return String((event as { type?: unknown }).type ?? "").toLowerCase();
}

function eventData(event: unknown): unknown {
  if (!event || typeof event !== "object") return undefined;
  return (event as { data?: unknown }).data;
}

export function liveUrlFromEvents(payload: unknown): string | undefined {
  const events = eventsOf(payload);
  for (const event of events) {
    if (!BROWSER_READY_TYPES.has(eventType(event))) continue;
    const url = pickLiveUrl(eventData(event)) ?? pickLiveUrl(event);
    if (url) return url;
  }
  for (const event of events) {
    const url = pickLiveUrl(event);
    if (url) return url;
  }
  return undefined;
}

export function liveUrlFromRunPayloads(opts: {
  run?: unknown;
  session?: unknown;
  events?: unknown;
}): string | undefined {
  return (
    pickLiveUrl(opts.run) ??
    pickLiveUrl(opts.session) ??
    liveUrlFromEvents(opts.events)
  );
}

export function runEventsPath(runId: string): string {
  return `/runs/${runId}/events?limit=200&after=0`;
}

function hostOf(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

function registrableHost(host: string): string {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

function identityHost(host: string): boolean {
  const head = host.split(".")[0] ?? "";
  return IDENTITY_HOST_PREFIXES.includes(head);
}

/** True when `seen` is the login page, same host, or the site's identity host. */
export function loginHostsMatch(targetPage: string, seenPage: string): boolean {
  const target = hostOf(targetPage);
  const seen = hostOf(seenPage);
  if (!target || !seen) return false;
  if (target === seen) return true;
  if (seen.endsWith(`.${target}`)) return true;
  if (registrableHost(target) === registrableHost(seen) && identityHost(seen)) {
    return true;
  }
  return false;
}

function isPreviewHost(host: string): boolean {
  return PREVIEW_HOSTS.has(host) || host.endsWith(".browser-use.com");
}

function asPageUrl(raw: string): string | undefined {
  const text = raw.trim().replace(/[),.;]+$/, "");
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return undefined;
    if (url.pathname === "/blank" || url.href.startsWith("about:")) return undefined;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!host || isPreviewHost(host)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function collectPageUrls(raw: unknown, depth = 0, into: string[] = []): string[] {
  if (depth > 6 || raw == null) return into;
  if (typeof raw === "string") {
    if (asPageUrl(raw)) {
      const one = asPageUrl(raw);
      if (one && !into.includes(one)) into.push(one);
      return into;
    }
    const matches = raw.match(HREF_RE) ?? [];
    for (const match of matches) {
      const one = asPageUrl(match);
      if (one && !into.includes(one)) into.push(one);
    }
    return into;
  }
  if (typeof raw !== "object") return into;
  if (Array.isArray(raw)) {
    for (const item of raw) collectPageUrls(item, depth + 1, into);
    return into;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (SKIP_URL_KEYS.has(key)) continue;
    collectPageUrls(value, depth + 1, into);
  }
  return into;
}

function toolName(event: unknown): string {
  const data = eventData(event);
  const type = eventType(event);
  const fromType = type.replace(/^(tool|action|browser)\./, "");
  if (!data || typeof data !== "object") return fromType;
  const rec = data as Record<string, unknown>;
  for (const key of ["name", "tool", "action", "function", "toolName", "tool_name"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fromType;
}

export function pageUrlsFromEvents(payload: unknown): string[] {
  const out: string[] = [];
  for (const event of eventsOf(payload)) {
    if (IGNORE_EVENT_TYPES.has(eventType(event))) continue;
    collectPageUrls(eventData(event) ?? event, 0, out);
  }
  return out;
}

export function pageUrlFromEvents(
  payload: unknown,
  targetPage?: string,
): string | undefined {
  const urls = pageUrlsFromEvents(payload);
  if (targetPage) {
    const match = urls.find((url) => loginHostsMatch(targetPage, url));
    if (match) return match;
  }
  return urls[0];
}

export function hasNavigateActivity(payload: unknown): boolean {
  for (const event of eventsOf(payload)) {
    if (IGNORE_EVENT_TYPES.has(eventType(event))) continue;
    if (NAV_TOOL.test(toolName(event))) return true;
  }
  return false;
}

/** Live URL exists and the Cloud agent has opened the site login (not blank). */
export function loginLandingReady(opts: {
  liveUrl?: string;
  targetPage?: string;
  events?: unknown;
}): boolean {
  if (!opts.liveUrl || !isLiveViewUrl(opts.liveUrl)) return false;
  const target = opts.targetPage?.trim();
  if (!target) return false;
  if (pageUrlFromEvents(opts.events, target)) return true;
  return hasNavigateActivity(opts.events);
}

export function shouldSendLoginLink(opts: {
  loginWait: boolean;
  liveUrl?: string;
  alreadySentAt?: number;
  landed?: boolean;
}): boolean {
  if (!opts.loginWait) return false;
  if (!opts.liveUrl || !isLiveViewUrl(opts.liveUrl)) return false;
  if (opts.alreadySentAt && opts.alreadySentAt > 0) return false;
  if (!opts.landed) return false;
  return true;
}
