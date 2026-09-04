import {
  isBrowserProfileId,
  LOGIN_MARK,
  loginWaitTask,
  normalizeBrowserProfileId,
  pickCookieDomains,
} from "../../convex/lib/browserProfilePolicy.ts";
import { payScaffold, type SecretBinding } from "./browser-pay.ts";

const BASE = "https://api.browser-use.com/api/v4";

export {
  isBrowserProfileId,
  loginWaitTask,
  normalizeBrowserProfileId,
};

/** ISO 3166-1 alpha-2 from BROWSERUSE_PROXY_COUNTRY. Unset → undefined (API default US). */
export function proxyCountryCode(
  raw: string | undefined = process.env.BROWSERUSE_PROXY_COUNTRY,
): string | undefined {
  const c = raw?.trim().toLowerCase();
  if (!c) return undefined;
  return /^[a-z]{2}$/.test(c) ? c : undefined;
}

/**
 * Browser Use API v4 create-run proxy country.
 * https://docs.browser-use.com/cloud/browser/proxies
 * Field: browserSettings.proxyCountryCode (REST/SDK camelCase).
 */
export function applyProxyCountry(
  body: Record<string, unknown>,
  country: string | undefined = proxyCountryCode(),
): Record<string, unknown> {
  if (!country) return body;
  return {
    ...body,
    browserSettings: { proxyCountryCode: country },
  };
}

function key(): string {
  const k = process.env.BROWSER_USE_API_KEY;
  if (!k) throw new Error("BROWSER_USE_API_KEY missing");
  return k;
}

async function bu(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
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
};

const ERRAND_MARK = "[bro-errand]";

export type ProfileView = {
  id: string;
  cookieDomains: string[];
};

/** Chrome cookies already on the Cloud profile — agent never sees passwords. */
export function envSyncedProfileId(
  raw: string | undefined = process.env.BROWSER_USE_PROFILE_ID,
): string | undefined {
  return normalizeBrowserProfileId(raw);
}

/** Wrap a raw errand with the cloud-browser operating envelope. Idempotent if already marked. */
export function scaffoldTask(
  task: string,
  opts?: { profileSynced?: boolean; pay?: Parameters<typeof payScaffold>[0] },
): string {
  if (task.startsWith(ERRAND_MARK) || task.startsWith(LOGIN_MARK)) return task;
  const payBlock = opts?.pay ? payScaffold(opts.pay) : undefined;
  const stopForPay = "Если нужна оплата — остановись и дай live-URL.";
  const login = opts?.profileSynced
    ? `Ты уже в аккаунтах человека: вход сохранён в Cloud-профиле. Пароли, номера карт, CVV и коды из SMS никогда не вводи сам. Если личный кабинет открыт — работай как залогиненный пользователь. Если сайт всё же просит логин — остановись; человек получит ссылку и войдёт сам. ${payBlock ?? stopForPay}`
    : `Никогда не вводи номера карт, CVV, пароли или коды из SMS сам. Если сайт просит логин — остановись. Bro пришлёт человеку ссылку, он войдёт сам, вход сохранится. ${payBlock ?? stopForPay}`;
  const finish = payBlock
    ? "Доводи дело до конца, включая оплату подключённой картой."
    : "Доводи дело до конца, если оплата не требуется (например: выбрать слот, заполнить форму с известными данными, дойти до финального подтверждения).";
  return `${ERRAND_MARK}
Выполняй поручение на языке сайтов (обычно русский). Задача: ${task}.
${login}
${finish}
Если данных не хватает (имя, телефон, адрес, время) — не выдумывай; закончи и перечисли, что нужно уточнить.
Работай быстро: если сайт медленный, требует капчу или недоступен — пропусти его и возьми другой вариант.
В конце верни краткий структурированный итог: что сделано; что нашёл (варианты с ценами/временами, до 5); что нужно от человека.`;
}

export async function createProfile(userId: string): Promise<string> {
  const created = await bu("/profiles", {
    method: "POST",
    body: JSON.stringify({ userId, name: userId }),
  });
  const id = pick(created, ["id"]);
  if (!id) throw new Error(`browser-use profile: no id in ${JSON.stringify(created).slice(0, 400)}`);
  return id;
}

function asProfile(body: Record<string, unknown>): ProfileView {
  const id = pick(body, ["id"]);
  if (!id || !isBrowserProfileId(id)) {
    throw new Error(`browser-use profile: no id in ${JSON.stringify(body).slice(0, 400)}`);
  }
  return { id, cookieDomains: pickCookieDomains(body.cookieDomains ?? body.cookie_domains) };
}

export async function getProfile(profileId: string): Promise<ProfileView> {
  const id = normalizeBrowserProfileId(profileId);
  if (!id) throw new Error("browser-use profile: invalid id");
  return asProfile(await bu(`/profiles/${id}`));
}

export async function listProfiles(query?: string): Promise<ProfileView[]> {
  const q = new URLSearchParams({ pageSize: "20", pageNumber: "1" });
  if (query?.trim()) q.set("query", query.trim().slice(0, 200));
  const listed = await bu(`/profiles?${q}`);
  const items = listed.items;
  if (!Array.isArray(items)) return [];
  const out: ProfileView[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    try {
      out.push(asProfile(item as Record<string, unknown>));
    } catch {
      // skip malformed rows
    }
  }
  return out;
}

function resolveProxyCountry(): string | undefined {
  const explicit = proxyCountryCode(process.env.BROWSERUSE_PROXY_COUNTRY);
  if (explicit) return explicit;
  const fallback = process.env.BRO_BROWSER_PROXY ?? "ru";
  if (fallback.trim().toLowerCase() === "none") return undefined;
  return proxyCountryCode(fallback);
}

export async function startRun(
  task: string,
  sessionId?: string,
  opts?: {
    profileId?: string;
    profileSynced?: boolean;
    pay?: Parameters<typeof payScaffold>[0];
    secretBindings?: SecretBinding[];
  },
): Promise<BrowserRun> {
  const body: Record<string, unknown> = {
    task: scaffoldTask(task, {
      profileSynced: opts?.profileSynced,
      pay: opts?.pay,
    }),
  };
  // Cloud JSON accepts both; send both so a session is reused.
  if (sessionId) {
    body.sessionId = sessionId;
    body.session_id = sessionId;
  }
  const country = resolveProxyCountry();
  body.browserSettings = {
    ...(country ? { proxyCountryCode: country } : {}),
    ...(opts?.profileId ? { profileId: opts.profileId } : {}),
  };
  const maxCost = Number(process.env.BRO_BROWSER_MAX_COST ?? "1");
  if (Number.isFinite(maxCost) && maxCost > 0) body.maxCostUsd = maxCost;
  if (process.env.BRO_BROWSER_MODEL) body.model = process.env.BRO_BROWSER_MODEL;
  if (opts?.secretBindings && opts.secretBindings.length > 0) {
    body.secretBindings = opts.secretBindings;
  }
  // A validation error can echo the offending field back; never let a bound
  // card value ride along in the thrown message when bindings are attached.
  const created = await bu("/runs", {
    method: "POST",
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    if (!body.secretBindings) throw err;
    const status = err instanceof Error ? err.message.match(/^browser-use (\d{3})/)?.[1] : undefined;
    throw new Error(`browser-use ${status ?? "error"} /runs (paid run, body redacted)`);
  });
  const runId =
    pick(created, ["id", "runId", "run_id"]) ??
    (typeof created.run === "object" && created.run
      ? pick(created.run as Record<string, unknown>, ["id"])
      : undefined);
  if (!runId) throw new Error(`browser-use create: no id in ${JSON.stringify(created).slice(0, 400)}`);
  const sid =
    pick(created, ["sessionId", "session_id"]) ??
    (typeof created.session === "object" && created.session
      ? pick(created.session as Record<string, unknown>, ["id"])
      : undefined);
  return hydrate(runId, sid);
}

export async function hydrate(
  runId: string,
  sessionId?: string,
): Promise<BrowserRun> {
  const run = await bu(`/runs/${runId}`);
  const session: Record<string, unknown> = sessionId
    ? await bu(`/sessions/${sessionId}`).catch(() => ({}))
    : {};
  const sid =
    sessionId ??
    pick(run, ["sessionId", "session_id"]) ??
    pick(session, ["id"]);
  const liveUrl =
    pick(run, ["liveUrl", "live_url"]) ??
    pick(session, ["liveUrl", "live_url"]) ??
    (typeof session.browser === "object" && session.browser
      ? pick(session.browser as Record<string, unknown>, ["liveUrl", "live_url"])
      : undefined);
  const result =
    pick(run, ["result", "output"]) ??
    (typeof run.result === "object" && run.result
      ? JSON.stringify(run.result).slice(0, 2000)
      : undefined);
  const status = pick(run, ["status"]) ?? "unknown";
  return { runId, sessionId: sid, status, liveUrl, result };
}

export async function waitForRun(
  runId: string,
  sessionId?: string,
  ms = 12_000,
): Promise<BrowserRun> {
  const start = Date.now();
  let last = await hydrate(runId, sessionId);
  while (Date.now() - start < ms) {
    const cheap = await bu(`/runs/${runId}/status`).catch(() => ({}));
    const status = pick(cheap, ["status"]) ?? last.status;
    if (isTerminal(status)) return hydrate(runId, last.sessionId);
    last = { ...last, status };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return hydrate(runId, last.sessionId);
}

export function isTerminal(status: string): boolean {
  return ["completed", "failed", "cancelled", "canceled", "stopped", "error"].includes(
    status.toLowerCase(),
  );
}

export async function waitForLiveUrl(
  run: BrowserRun,
  ms = 12_000,
): Promise<BrowserRun> {
  if (run.liveUrl) return run;
  const start = Date.now();
  let last = run;
  while (Date.now() - start < ms) {
    last = await hydrate(last.runId, last.sessionId);
    if (last.liveUrl) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}
