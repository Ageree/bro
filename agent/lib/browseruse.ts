import {
  isBrowserProfileId,
  LOGIN_MARK,
  LOGIN_VAULT_MARK,
  loginWaitTask,
  normalizeBrowserProfileId,
  pickCookieDomains,
} from "../../convex/lib/browserProfilePolicy.ts";
import {
  liveUrlFromRunPayloads,
  loginHostsMatch,
  loginLandingReady,
  pageUrlFromEvents,
  runEventsPath,
} from "../../convex/lib/browserLivePolicy.ts";
import {
  browserFromList,
  cdpPageUrl,
  type CloudBrowser,
} from "../../convex/lib/browserCdp.ts";
import { cdpNavigate } from "./browser-cdp.ts";
import { loginScaffold, payScaffold, type SecretBinding } from "./browser-pay.ts";

const BASE = "https://api.browser-use.com/api/v4";

/** Browser Use Cloud recommended V4 model. Flash kept dying mid-answer. */
export const DEFAULT_BROWSER_MODEL = "gpt-5.6-luna";

export {
  isBrowserProfileId,
  loginWaitTask,
  normalizeBrowserProfileId,
};

/** Cloud `model` for POST /runs. Empty BRO_BROWSER_MODEL keeps the default. */
export function resolveBrowserModel(
  raw: string | undefined = process.env.BRO_BROWSER_MODEL,
): string {
  const model = raw?.trim();
  return model ? model : DEFAULT_BROWSER_MODEL;
}

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
  pageUrl?: string;
  landed?: boolean;
};

const ERRAND_MARK = "[bro-errand]";

export type ProfileView = {
  id: string;
  cookieDomains: string[];
};

/** Chrome cookies already on the Cloud profile. Type a password only if the task includes one. */
export function envSyncedProfileId(
  raw: string | undefined = process.env.BROWSER_USE_PROFILE_ID,
): string | undefined {
  return normalizeBrowserProfileId(raw);
}

/** Wrap a raw errand with the cloud-browser operating envelope. Idempotent if already marked. */
export function scaffoldTask(
  task: string,
  opts?: {
    profileSynced?: boolean;
    pay?: Parameters<typeof payScaffold>[0];
    login?: boolean;
    startPage?: string;
  },
): string {
  if (
    task.startsWith(ERRAND_MARK) ||
    task.startsWith(LOGIN_MARK) ||
    task.startsWith(LOGIN_VAULT_MARK)
  ) {
    return task;
  }
  const payBlock = opts?.pay ? payScaffold(opts.pay) : undefined;
  const loginBlock = opts?.login ? loginScaffold() : undefined;
  const stopForPay = "Если нужна оплата — остановись и дай live-URL.";
  const stopForLogin =
    "Если пароля в задаче нет и сайт просит логин — остановись. Bro пришлёт человеку ссылку, он войдёт сам, вход сохранится.";
  const stopForLoginSynced =
    "Если пароля в задаче нет и сайт всё же просит логин — остановись; Bro пришлёт человеку ссылку, он войдёт сам.";
  const login = opts?.profileSynced
    ? `Ты уже в аккаунтах человека: вход сохранён в Cloud-профиле. Если личный кабинет открыт — работай как залогиненный пользователь. Если в задаче есть логин или пароль — введи их на входе и на регистрации, не цитируй. Номера карт, CVV и коды из SMS сам не выдумывай. ${loginBlock ?? stopForLoginSynced} ${payBlock ?? stopForPay}`
    : `Если в задаче есть логин или пароль — введи их на входе и на регистрации, не цитируй. Номера карт и CVV сам не вводи. ${loginBlock ?? stopForLogin} ${payBlock ?? stopForPay}`;
  const finish = payBlock
    ? "Доводи дело до конца, включая оплату подключённой картой."
    : "Доводи дело до конца, если оплата не требуется (например: выбрать слот, заполнить форму с известными данными, дойти до финального подтверждения).";
  const alreadyOpen = opts?.startPage
    ? `Страница уже открыта: ${opts.startPage}. Не уходи на about:blank. Не открывай паспорт, если аккаунт уже свой.`
    : "Сайт откроет Bro сам. Не сиди на about:blank.";
  return `${ERRAND_MARK}
Выполняй поручение на языке сайтов (обычно русский). Задача: ${task}.
${alreadyOpen}
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
    login?: boolean;
    secretBindings?: SecretBinding[];
    startPage?: string;
  },
): Promise<BrowserRun> {
  // Cloud v4 POST /runs has no startUrl / initial navigation field
  // (RunBrowserSettings.additionalProperties = false). Eve opens the
  // site via CDP after browser.ready — do not wait for the Cloud LLM.
  const body: Record<string, unknown> = {
    task: scaffoldTask(task, {
      profileSynced: opts?.profileSynced,
      pay: opts?.pay,
      login: opts?.login,
      startPage: opts?.startPage,
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
  body.model = resolveBrowserModel();
  if (opts?.secretBindings && opts.secretBindings.length > 0) {
    body.secretBindings = opts.secretBindings;
  }
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

async function runEvents(runId: string): Promise<unknown> {
  return await bu(runEventsPath(runId)).catch(() => undefined);
}

function withLanding(
  run: BrowserRun,
  events: unknown,
  targetPage?: string,
): BrowserRun {
  const pageUrl = pageUrlFromEvents(events, targetPage) ?? run.pageUrl;
  const liveUrl = run.liveUrl ?? liveUrlFromRunPayloads({ events });
  const landed = targetPage
    ? loginLandingReady({ liveUrl, targetPage, events, pageUrl })
    : run.landed;
  return {
    ...run,
    ...(liveUrl ? { liveUrl } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(targetPage !== undefined ? { landed } : {}),
  };
}

export async function findBrowserForSession(
  sessionId?: string,
): Promise<CloudBrowser | undefined> {
  if (!sessionId) return undefined;
  return browserFromList(await bu("/browsers"), sessionId);
}

async function applyCdpPage(
  run: BrowserRun,
  targetPage?: string,
): Promise<BrowserRun> {
  const browser = await findBrowserForSession(run.sessionId).catch(() => undefined);
  const liveUrl = run.liveUrl ?? browser?.liveUrl;
  if (!browser?.cdpUrl) {
    return liveUrl && liveUrl !== run.liveUrl ? { ...run, liveUrl } : run;
  }
  const pageUrl = await cdpPageUrl(browser.cdpUrl).catch(() => undefined);
  const next: BrowserRun = {
    ...run,
    ...(liveUrl ? { liveUrl } : {}),
    ...(pageUrl ? { pageUrl } : {}),
  };
  if (!targetPage) return next;
  return {
    ...next,
    landed: loginLandingReady({
      liveUrl: next.liveUrl,
      targetPage,
      pageUrl: next.pageUrl,
    }),
  };
}

export async function hydrate(
  runId: string,
  sessionId?: string,
  targetPage?: string,
): Promise<BrowserRun> {
  const run = await bu(`/runs/${runId}`);
  const status = pick(run, ["status"]) ?? "unknown";
  const nestedLive = liveUrlFromRunPayloads({ run });
  const session: Record<string, unknown> =
    sessionId && (isTerminal(status) || !nestedLive)
      ? await bu(`/sessions/${sessionId}`).catch(() => ({}))
      : {};
  const sid =
    sessionId ??
    pick(run, ["sessionId", "session_id"]) ??
    pick(session, ["id"]);
  const events = await runEvents(runId);
  const liveUrl =
    liveUrlFromRunPayloads({ run, session, events });
  const result =
    pick(run, ["result", "output"]) ??
    (typeof run.result === "object" && run.result
      ? JSON.stringify(run.result).slice(0, 2000)
      : undefined);
  return applyCdpPage(
    withLanding(
      { runId, sessionId: sid, status, liveUrl, result },
      events,
      targetPage,
    ),
    targetPage,
  );
}

export async function waitForRun(
  runId: string,
  sessionId?: string,
  ms = 12_000,
): Promise<BrowserRun> {
  const start = Date.now();
  let last: BrowserRun = { runId, sessionId, status: "unknown" };
  while (Date.now() - start < ms) {
    const cheap = await bu(`/runs/${runId}/status`).catch(() => ({}));
    const status = pick(cheap, ["status"]) ?? last.status;
    if (isTerminal(status)) return hydrate(runId, last.sessionId ?? sessionId);
    last = { ...last, status };
    const remaining = ms - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(2000, remaining)));
  }
  return hydrate(runId, last.sessionId ?? sessionId);
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
    const events = await runEvents(last.runId);
    last = withLanding(last, events);
    const fromEvents = liveUrlFromRunPayloads({ events });
    if (fromEvents) return { ...last, liveUrl: fromEvents };
    last = await hydrate(last.runId, last.sessionId);
    if (last.liveUrl) return last;
    const remaining = ms - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(1000, remaining)));
  }
  return last;
}

/** Wait until live preview exists AND the real tab is the target site. */
export async function waitForPageLanding(
  run: BrowserRun,
  targetPage: string,
  ms = 45_000,
): Promise<BrowserRun> {
  const start = Date.now();
  let last = run;
  let navigated = false;
  while (Date.now() - start < ms) {
    last = await hydrate(last.runId, last.sessionId, targetPage);
    if (last.liveUrl && last.landed) return last;
    const browser = await findBrowserForSession(last.sessionId).catch(
      () => undefined,
    );
    const liveUrl = last.liveUrl ?? browser?.liveUrl;
    if (browser?.cdpUrl && liveUrl && !navigated) {
      const after = await cdpNavigate(browser.cdpUrl, targetPage).catch(
        (err: unknown) => {
          console.error("cdp page navigate failed", err);
          return undefined;
        },
      );
      navigated = true;
      if (after && loginHostsMatch(targetPage, after)) {
        return { ...last, liveUrl, pageUrl: after, landed: true };
      }
    }
    const remaining = ms - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(1500, remaining)));
  }
  return last.landed !== undefined
    ? last
    : { ...last, landed: false };
}

/** Login wait: same as page landing, longer budget for the form. */
export async function waitForLoginLanding(
  run: BrowserRun,
  targetPage: string,
  ms = 45_000,
): Promise<BrowserRun> {
  return waitForPageLanding(run, targetPage, ms);
}
