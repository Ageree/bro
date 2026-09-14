/**
 * Browser Use Cloud v4 live preview lives on run events, not GET /runs.
 * https://docs.browser-use.com/cloud/browser/live-preview
 * `browser.ready` → data.live_view_url (also camelCase / legacy liveUrl).
 */

export const BROWSER_READY_TYPES = new Set(["browser.ready", "browser_ready"]);

export const LOGIN_LIVE_WAIT_MS = 25_000;

const LIVE_URL_KEYS = new Set([
  "live_view_url",
  "liveViewUrl",
  "liveUrl",
  "live_url",
]);

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

export function liveUrlFromEvents(payload: unknown): string | undefined {
  const events = eventsOf(payload);
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const type = String((event as { type?: unknown }).type ?? "").toLowerCase();
    if (!BROWSER_READY_TYPES.has(type)) continue;
    const url =
      pickLiveUrl((event as { data?: unknown }).data) ?? pickLiveUrl(event);
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

export function shouldSendLoginLink(opts: {
  loginWait: boolean;
  liveUrl?: string;
  alreadySentAt?: number;
}): boolean {
  if (!opts.loginWait) return false;
  if (!opts.liveUrl || !isLiveViewUrl(opts.liveUrl)) return false;
  if (opts.alreadySentAt && opts.alreadySentAt > 0) return false;
  return true;
}
