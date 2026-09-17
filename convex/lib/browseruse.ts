import {
  isBrowserProfileId,
  normalizeBrowserProfileId,
  pickCookieDomains,
} from "./browserProfilePolicy.ts";
import {
  liveUrlFromRunPayloads,
  loginLandingReady,
  pageUrlFromEvents,
  runEventsPath,
} from "./browserLivePolicy.ts";
import { browserFromList, cdpPageUrl } from "./browserCdp.ts";
import { scrubSecrets } from "./secretScrub.ts";

const DEFAULT_BASE = "https://api.browser-use.com/api/v4";

/** Same `BROWSER_USE_BASE_URL` override as the eve-side client — follow-through
 *  polling runs here, on the Convex deployment, so a staging environment that
 *  only redirected one of the two would start a fake run and then poll the
 *  real API for a run id it has never heard of. See `agent/lib/browseruse.ts`
 *  for why this is a base URL and not a "pretend" flag. */
function base(): string {
  return process.env.BROWSER_USE_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_BASE;
}

/** Fixed prefix so a config error is recognisable by message alone (logs, retries). */
const CONFIG_ERROR_MARKER = "browser-use config:";

/**
 * A misconfigured deployment (no API key), distinct from a transient/network
 * failure — the incident this guards against: hydrate/pollStatus used to
 * swallow this the same as a network blip, so every run "hung" for the full
 * 20-minute poll budget with nothing telling a human the deployment was
 * broken. Callers must rethrow this, never degrade it to "unknown".
 */
export class BrowserUseConfigError extends Error {
  constructor(message: string) {
    super(`${CONFIG_ERROR_MARKER} ${message}`);
    this.name = "BrowserUseConfigError";
  }
}

export function isBrowserUseConfigError(err: unknown): boolean {
  if (err instanceof BrowserUseConfigError) return true;
  return err instanceof Error && err.message.startsWith(CONFIG_ERROR_MARKER);
}

/**
 * Every whitespace character is stripped, not just the ends — the same
 * pathology `agent/lib/browseruse.ts` documents, and the follow-through
 * polling that runs here reads the very same secret. Observed for real: the
 * value came back from the store with a newline in the MIDDLE, and `fetch`
 * rejects such a header outright (`Headers.append: "…" is an invalid header
 * value`), so the request never left the process. `.trim()` only touches the
 * ends. A Browser Use key has no internal whitespace of its own, so this can
 * only rescue a wrapped key, never corrupt a valid one.
 */
export function normalizeBrowserUseKey(raw: string | undefined): string | undefined {
  return raw?.replace(/\s+/gu, "") || undefined;
}

/** Once per process: the request is rescued, but the stored secret is still
 *  malformed and only a human can fix that. */
let warnedWrappedKey = false;

function key(): string {
  const raw = process.env.BROWSERUSE_API_KEY ?? process.env.BROWSER_USE_API_KEY;
  const k = normalizeBrowserUseKey(raw);
  if (raw !== undefined && raw !== k && !warnedWrappedKey) {
    warnedWrappedKey = true;
    // Never the value itself — just that it is wrapped, and where to look.
    console.warn(
      "BROWSERUSE_API_KEY contains whitespace (a newline mid-value survives a paste into a hosted env); stripping it for the request, but re-set the stored secret",
    );
  }
  if (!k) throw new BrowserUseConfigError("BROWSERUSE_API_KEY missing");
  return k;
}

async function bu(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      "X-Browser-Use-API-Key": key(),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new Error(`browser-use ${res.status} ${path}: ${text.slice(0, 400)}`);
  }
  return body;
}

function pick(obj: Record<string, unknown>, names: string[]): string | undefined {
  for (const n of names) {
    const v = obj[n];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export type BrowserRun = {
  runId: string;
  sessionId?: string;
  status: string;
  liveUrl?: string;
  result?: string;
  pageUrl?: string;
  landed?: boolean;
};

export type ProfileView = {
  id: string;
  cookieDomains: string[];
};

export async function getProfile(profileId: string): Promise<ProfileView> {
  const id = normalizeBrowserProfileId(profileId);
  if (!id) throw new Error("browser-use profile: invalid id");
  const body = await bu(`/profiles/${id}`);
  const got = pick(body, ["id"]);
  if (!got || !isBrowserProfileId(got)) {
    throw new Error(`browser-use profile: no id in ${JSON.stringify(body).slice(0, 400)}`);
  }
  return {
    id: got,
    cookieDomains: pickCookieDomains(body.cookieDomains ?? body.cookie_domains),
  };
}

export async function hydrate(
  runId: string,
  sessionId?: string,
  targetPage?: string,
): Promise<BrowserRun> {
  // Primary fetch: guarded like every other enrichment call below, so a
  // transient upstream hiccup degrades to "unknown" instead of throwing.
  // A config error (e.g. missing API key) is NOT transient — every future
  // poll would fail the same way, so it must propagate instead of degrading
  // to "unknown" (the incident this guards against: pollRun treated
  // "unknown" as a momentary miss and kept polling for the full 20-minute
  // give-up budget while every single poll was actually erroring).
  const run = await bu(`/runs/${runId}`).catch((err: unknown) => {
    if (isBrowserUseConfigError(err)) throw err;
    console.error("browser run fetch failed", err);
    return undefined;
  });
  if (!run) return { runId, sessionId, status: "unknown" };
  const session: Record<string, unknown> = sessionId
    ? await bu(`/sessions/${sessionId}`).catch(() => ({}))
    : {};
  const sid =
    sessionId ??
    pick(run, ["sessionId", "session_id"]) ??
    pick(session, ["id"]);
  const events = await bu(runEventsPath(runId)).catch(() => undefined);
  const listed = sid ? await bu("/browsers").catch(() => undefined) : undefined;
  const cloud = sid ? browserFromList(listed, sid) : undefined;
  const liveUrl =
    liveUrlFromRunPayloads({ run, session, events }) ?? cloud?.liveUrl;
  const eventPage = pageUrlFromEvents(events, targetPage);
  const cdpPage = cloud?.cdpUrl
    ? await cdpPageUrl(cloud.cdpUrl).catch(() => undefined)
    : undefined;
  const pageUrl = eventPage ?? cdpPage;
  const landed = loginLandingReady({
    liveUrl,
    targetPage,
    events,
    pageUrl,
  });
  const rawResult =
    pick(run, ["result", "output"]) ??
    (typeof run.result === "object" && run.result
      ? JSON.stringify(run.result).slice(0, 2000)
      : undefined);
  const result = rawResult ? scrubSecrets(rawResult) : rawResult;
  const status = pick(run, ["status"]) ?? "unknown";
  return {
    runId,
    sessionId: sid,
    status,
    liveUrl,
    result,
    ...(pageUrl ? { pageUrl } : {}),
    ...(targetPage ? { landed } : {}),
  };
}

/**
 * POST /runs/{id}/cancel — idempotent, blocks further billing on that run.
 * Best effort: 404 (already gone) is fine; never throw to callers.
 */
export async function cancelRun(runId: string): Promise<boolean> {
  try {
    await bu(`/runs/${runId}/cancel`, { method: "POST" });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/^browser-use 404\b/.test(msg) || /^browser-use 409\b/.test(msg)) return true;
    console.error("browser cancel run failed", err);
    return false;
  }
}

/** PATCH /browsers/{id} {"action":"stop"} — a completed run leaves its browser up. */
export async function stopBrowserForSession(sessionId: string): Promise<boolean> {
  try {
    const listed = await bu("/browsers");
    const browser = browserFromList(listed, sessionId);
    if (!browser?.id) return false;
    await bu(`/browsers/${browser.id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "stop" }),
    });
    return true;
  } catch (err) {
    console.error("browser stop session failed", err);
    return false;
  }
}

export async function pollStatus(
  runId: string,
  sessionId?: string,
): Promise<BrowserRun> {
  const cheap = await bu(`/runs/${runId}/status`).catch((err: unknown) => {
    if (isBrowserUseConfigError(err)) throw err;
    return {};
  });
  const status = pick(cheap, ["status"]);
  if (!status) return hydrate(runId, sessionId);
  return { runId, sessionId, status };
}
