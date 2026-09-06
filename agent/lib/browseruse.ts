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

export type BrowserRunKind = "errand" | "login" | "pay";
export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Cloud's cheapest V4 model. Omitting `model` also picks this, but pin it. */
export const DEFAULT_BROWSER_MODEL = "gpt-5.6-luna";

/**
 * Per-kind USD caps. Login only opens a page and waits.
 * Pay needs a longer checkout. Env `BRO_BROWSER_MAX_COST` overrides all three.
 * Medium/high reasoning spends more output tokens than `low`, so errand/pay
 * sit above the old 0.45 / 0.80 floors.
 */
export const DEFAULT_MAX_COST_USD: Record<BrowserRunKind, number> = {
  login: 0.15,
  errand: 0.6,
  pay: 1,
};

/**
 * Cloud defaults Luna to `reasoning.effort: xhigh` when modelParams is omitted
 * (token furnace). OpenAI's own Luna default is `medium`. `low` is below both
 * and is the nano-tier's weakest setting — WB/Ozon errands need more.
 * Login stays `none` (open page, wait). Pay uses `high` (checkout judgment).
 * https://docs.browser-use.com/cloud/agent/thinking-levels
 * https://developers.openai.com/api/docs/models/gpt-5.6-luna
 */
export const DEFAULT_REASONING_EFFORT: Record<BrowserRunKind, ReasoningEffort> = {
  login: "none",
  errand: "medium",
  pay: "high",
};

const REASONING_EFFORTS = new Set<string>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function detectRunKind(
  task: string,
  opts?: { pay?: unknown },
): BrowserRunKind {
  if (opts?.pay != null) return "pay";
  if (task.startsWith(LOGIN_MARK)) return "login";
  return "errand";
}

export function browserModel(
  raw: string | undefined = process.env.BRO_BROWSER_MODEL,
): string {
  const m = raw?.trim();
  return m || DEFAULT_BROWSER_MODEL;
}

function positiveUsd(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function maxCostUsd(
  kind: BrowserRunKind,
  raw: string | undefined = process.env.BRO_BROWSER_MAX_COST,
): number {
  return positiveUsd(raw, DEFAULT_MAX_COST_USD[kind]);
}

export function reasoningEffort(
  kind: BrowserRunKind,
  raw: string | undefined = process.env.BRO_BROWSER_REASONING,
): ReasoningEffort {
  const v = raw?.trim().toLowerCase();
  if (v && REASONING_EFFORTS.has(v)) return v as ReasoningEffort;
  return DEFAULT_REASONING_EFFORT[kind];
}

/** gpt-5.5 / gpt-5.6* accept modelParams.reasoning.effort. Others 422. */
export function acceptsReasoningEffort(model: string): boolean {
  return /^gpt-5\.(5|6)\b/.test(model.trim());
}

export function modelParamsFor(
  model: string,
  effort: ReasoningEffort,
): { reasoning: { effort: ReasoningEffort } } | undefined {
  if (!acceptsReasoningEffort(model)) return undefined;
  return { reasoning: { effort } };
}

export type CustomProxy = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};

/**
 * Vendor gateways (DataImpulse: `__cr.ru;sessttl.30`) encode geo/sticky in the
 * username. Append `suffix` unless the login already carries it.
 */
export function decorateProxyUser(
  user: string | undefined,
  suffix: string | undefined,
): string | undefined {
  const u = user?.trim();
  if (!u) return undefined;
  const s = suffix?.trim();
  if (!s || u.includes(s)) return u;
  return `${u}${s}`;
}

export function customProxyFromEnv(env: {
  BRO_BROWSER_PROXY_HOST?: string;
  BRO_BROWSER_PROXY_PORT?: string;
  BRO_BROWSER_PROXY_USER?: string;
  BRO_BROWSER_PROXY_PASS?: string;
  BRO_BROWSER_PROXY_USER_SUFFIX?: string;
} = process.env): CustomProxy | undefined {
  const host = env.BRO_BROWSER_PROXY_HOST?.trim();
  const port = Number(env.BRO_BROWSER_PROXY_PORT);
  if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
    return undefined;
  }
  const username = decorateProxyUser(
    env.BRO_BROWSER_PROXY_USER,
    env.BRO_BROWSER_PROXY_USER_SUFFIX,
  );
  const password = env.BRO_BROWSER_PROXY_PASS?.trim();
  return {
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

export function browserSettingsForRun(opts: {
  country?: string;
  profileId?: string;
  customProxy?: CustomProxy;
}): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (opts.customProxy) {
    settings.customProxy = {
      host: opts.customProxy.host,
      port: opts.customProxy.port,
      ...(opts.customProxy.username
        ? { username: opts.customProxy.username }
        : {}),
      ...(opts.customProxy.password
        ? { password: opts.customProxy.password }
        : {}),
    };
    // Custom proxy overrides country; null turns off $5/GB managed residential.
    settings.proxyCountryCode = null;
  } else if (opts.country) {
    settings.proxyCountryCode = opts.country;
  } else {
    // Omitting the field keeps Cloud's US residential ($5/GB). null = proxyless.
    // https://docs.browser-use.com/cloud/browser/proxies
    settings.proxyCountryCode = null;
  }
  if (opts.profileId) settings.profileId = opts.profileId;
  return settings;
}

export function buildRunBody(opts: {
  task: string;
  sessionId?: string;
  profileId?: string;
  profileSynced?: boolean;
  pay?: Parameters<typeof payScaffold>[0];
  secretBindings?: SecretBinding[];
  proxyCountry?: string;
  customProxy?: CustomProxy;
  model?: string;
  maxCostUsd?: number;
  reasoningEffort?: ReasoningEffort;
}): Record<string, unknown> {
  const kind = detectRunKind(opts.task, { pay: opts.pay });
  const model = opts.model ?? browserModel();
  const effort = opts.reasoningEffort ?? reasoningEffort(kind);
  const cost = opts.maxCostUsd ?? maxCostUsd(kind);
  const body: Record<string, unknown> = {
    task: scaffoldTask(opts.task, {
      profileSynced: opts.profileSynced,
      pay: opts.pay,
    }),
    model,
    maxCostUsd: cost,
  };
  if (opts.sessionId) {
    body.sessionId = opts.sessionId;
    body.session_id = opts.sessionId;
  }
  body.browserSettings = browserSettingsForRun({
    country: opts.proxyCountry,
    profileId: opts.profileId,
    customProxy: opts.customProxy,
  });
  const params = modelParamsFor(model, effort);
  if (params) body.modelParams = params;
  if (opts.secretBindings && opts.secretBindings.length > 0) {
    body.secretBindings = opts.secretBindings;
  }
  return body;
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
    ? `Уже в аккаунтах: вход в Cloud-профиле. Пароли, карты, CVV, SMS не вводи. Кабинет открыт — работай. Просит логин — остановись. ${payBlock ?? stopForPay}`
    : `Пароли, карты, CVV, SMS не вводи. Просит логин — остановись. Bro пришлёт человеку ссылку. ${payBlock ?? stopForPay}`;
  const finish = payBlock
    ? "Доводи дело до конца, включая оплату подключённой картой."
    : "Доводи дело до конца, если оплата не требуется (слот, форма, подтверждение).";
  return `${ERRAND_MARK}
Язык сайтов (обычно русский). Задача: ${task}.
${login}
${finish}
Нет имени/телефона/адреса/времени — не выдумывай, закончи и перечисли, чего не хватает.
Работай быстро: медленный сайт, капча, недоступен — пропусти и возьми другой. Не листать витрину и не снимать лишние скриншоты.
Итог коротко: что сделано; до 5 вариантов с ценами/временами; что нужно от человека.`;
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

/**
 * Managed residential is opt-in. Unset / `none` → no country (caller sends null).
 * Cloud's own default if the field is omitted is US residential at $5/GB.
 */
export function resolveProxyCountry(
  explicitRaw: string | undefined = process.env.BROWSERUSE_PROXY_COUNTRY,
  fallbackRaw: string | undefined = process.env.BRO_BROWSER_PROXY,
): string | undefined {
  const explicit = proxyCountryCode(explicitRaw);
  if (explicit) return explicit;
  const fallback = (fallbackRaw ?? "none").trim().toLowerCase();
  if (!fallback || fallback === "none") return undefined;
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
  const body = buildRunBody({
    task,
    sessionId,
    profileId: opts?.profileId,
    profileSynced: opts?.profileSynced,
    pay: opts?.pay,
    secretBindings: opts?.secretBindings,
    proxyCountry: resolveProxyCountry(),
    customProxy: customProxyFromEnv(),
  });
  // A validation error can echo the offending field back; never let a bound
  // card value ride along in the thrown message when bindings are attached.
  const created = await bu("/runs", {
    method: "POST",
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    const status =
      body.secretBindings && err instanceof Error
        ? /^browser-use (\d{3})/.exec(err.message)?.[1]
        : undefined;
    if (!status) throw err;
    throw new Error(`browser-use ${status} /runs (paid run, response redacted)`);
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
