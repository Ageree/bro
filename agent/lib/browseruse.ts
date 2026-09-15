import { createHash } from "node:crypto";
import {
  isBrowserProfileId,
  LOGIN_MARK,
  LOGIN_VAULT_MARK,
  loginWaitTask,
  normalizeBrowserProfileId,
  pickCookieDomains,
} from "../../convex/lib/browserProfilePolicy.ts";
import { INJECT_MARK } from "../../convex/lib/browserInjectPolicy.ts";
import { DONE } from "../../convex/lib/browserFollowPolicy.ts";
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
import { scrubSecrets } from "../../convex/lib/secretScrub.ts";
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

/**
 * Only an explicit dry-run skips «Заказать».
 * A real «вызови такси» must finish the order after login.
 */
export function isDryRunErrand(task: string): boolean {
  const t = task.toLowerCase();
  return (
    /не\s+нажимай(?:те)?\s+[«"']?заказать/.test(t) ||
    /не\s+нажимать\s+[«"']?заказать/.test(t) ||
    /не\s+заказывай/.test(t) ||
    /\bбез\s+заказа\b/.test(t) ||
    /dry[- ]?run/.test(t) ||
    /не\s+создавай\s+(?:реальн\w*\s+)?(?:поездк|заказ)/.test(t)
  );
}

function errandLoginBlock(opts?: {
  login?: boolean;
  profileSynced?: boolean;
}): string {
  const session = opts?.profileSynced
    ? "В профиле уже могут быть куки прошлой сессии — используй их. Куки не значат, что ты уже вошёл: смотри на экран, а не на куки."
    : "Сохранённой сессии может не быть.";
  const vault = opts?.login ? `${loginScaffold()}\n` : "";
  const typed = opts?.login
    ? ""
    : "Если в задаче есть логин или пароль — введи их на входе и на регистрации, не цитируй. ";
  return `${session} Если видишь «Войти», «Авторизоваться» или гостевую форму — войди сам (паспорт, Яндекс ID, телефон — так и надо). Не останавливайся на гостевом экране.
${vault}${typed}Нет пароля и без него дальше нельзя — закончи итог с НУЖНО: password. Код из SMS — НУЖНО: sms_code. Код на почту — НУЖНО: email_code. Подтверждение в приложении или пуш — НУЖНО: push. Не выдумывай пароль. Номера карт и CVV сам не вводи, если карта не подключена секретами.`;
}

function errandFinishBlock(
  task: string,
  payBlock: string | undefined,
): string {
  if (payBlock) {
    return "Доводи дело до конца, включая оплату подключённой картой. Прежде чем оформить — проверь, что товар или услуга не добавлены в корзину дважды. После оплаты проверь, что на экране виден номер заказа — без него это не «готово».";
  }
  if (isDryRunErrand(task)) {
    return "Это проверка без заказа: покажи форму и цену. Не нажимай «Заказать», «Поехали» и не создавай поездку.";
  }
  return "Доводи дело до конца: жми финальную кнопку (нажми «Заказать», «Записаться» и т.п.), если человек просил довести дело до конца. Для такси после входа заполни откуда/куда и нажми «Заказать». Прежде чем оформить — проверь, что заказ не создан дважды. Гостевой экран без попытки войти — не результат.";
}

export type ProfileView = {
  id: string;
  cookieDomains: string[];
};

/**
 * Chrome cookies already on the Cloud profile. Type a password only if the task includes one.
 * `BROWSER_USE_PROFILE_ID` is only shared across runs when `BROWSER_USE_PROFILE_PHONE`
 * names the one tenant it belongs to — otherwise every tenant gets their own profile.
 */
export function envSyncedProfileId(
  phone: string,
  raw: string | undefined = process.env.BROWSER_USE_PROFILE_ID,
  ownerPhone: string | undefined = process.env.BROWSER_USE_PROFILE_PHONE,
): string | undefined {
  if (!ownerPhone || ownerPhone.trim() !== phone.trim()) return undefined;
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
    /** This run continues a PREVIOUS step of the same errand in the same
     *  Cloud session — the page is already open and mid-flow. Never true
     *  together with `startPage` (there is no fresh navigation to do). */
    continuation?: boolean;
  },
): string {
  if (
    task.startsWith(ERRAND_MARK) ||
    task.startsWith(LOGIN_MARK) ||
    task.startsWith(LOGIN_VAULT_MARK) ||
    task.startsWith(INJECT_MARK)
  ) {
    return task;
  }
  const payBlock = opts?.pay ? payScaffold(opts.pay) : undefined;
  const stopForPay = "Если по ходу нужна оплата — закончи итог с НУЖНО: payment.";
  const login = errandLoginBlock({
    login: opts?.login,
    profileSynced: opts?.profileSynced,
  });
  const finish = errandFinishBlock(task, payBlock);
  // A continuation must never re-navigate or redo what the previous step of
  // THIS SAME errand already did (the taxi incident: a fresh run re-drove
  // the whole route because eve tore down the old browser first) — the tab
  // is already open exactly where the last step left it.
  const alreadyOpen = opts?.continuation
    ? "Страница уже открыта на предыдущем шаге этого же поручения — продолжай с текущего состояния. Не перезагружай страницу, не открывай сайт заново и не вводи заново маршрут или данные, которые уже введены. Ниже — то, что человек только что прислал."
    : opts?.startPage
      ? `Страница уже открыта: ${opts.startPage}. Не уходи на about:blank. Если сайт открывает паспорт или форму входа — иди туда и войди.`
      : "Сайт откроет Bro сам. Не сиди на about:blank. Если нужна авторизация — открой вход и войди.";
  return `${ERRAND_MARK}
Выполняй поручение на языке сайтов (обычно русский). Задача: ${task}.
${alreadyOpen}
Сначала закрой баннеры cookie, промо и подписки — не читая их. Если сайт спрашивает город или регион — выбери тот, что в задаче, или ближайший смысловой; не спрашивай человека.
${login} ${payBlock ?? stopForPay}
${finish}
Если данных не хватает (имя, телефон, адрес, время, размер) — не выдумывай; перечисли в итоге (ДЕТАЛИ) и поставь НУЖНО: address, payment или info — какое подходит.
Работай быстро: если сайт медленный или недоступен — пропусти его и возьми другой вариант. Капча без выхода — закончи итог с НУЖНО: captcha.

Итог — только в этом формате, каждое поле с новой строки:
СДЕЛАНО: <одна фраза>
ЗАКАЗ: <номер или нет>
СУММА: <число ₽ или нет>
КОГДА: <дата/время/ETA или нет>
ВАРИАНТЫ: <до 5 «название — цена — ссылка», через ; или нет>
НУЖНО: none|sms_code|email_code|push|3ds|captcha|password|address|payment|info
ДЕТАЛИ: <что именно нужно от человека, одной строкой, или нет>
Никогда не пиши в итог пароль, номер карты или код.`;
}

/** Stable, non-reversible profile name/id — never the raw phone number. */
export function hashedProfileName(phone: string): string {
  const digest = createHash("sha256")
    .update(`browseruse-profile\0${phone}`)
    .digest("hex");
  return `bro-${digest.slice(0, 40)}`;
}

export async function createProfile(phone: string): Promise<string> {
  const name = hashedProfileName(phone);
  const created = await bu("/profiles", {
    method: "POST",
    body: JSON.stringify({ userId: name, name }),
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
    /** Resume the same errand in `sessionId`'s already-open tab — see
     *  `scaffoldTask`. Never combined with `startPage`. */
    continuation?: boolean;
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
      continuation: opts?.continuation,
    }),
  };
  // v4 POST /runs rejects unknown keys outright (422 extra_forbidden) —
  // `session_id` is not a real field, only `sessionId` is; sending both
  // used to fail every session-reusing call (fresh-start login continuation,
  // inject/resume, and now `continue`).
  if (sessionId) {
    body.sessionId = sessionId;
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

export type QueuedMessage = {
  id?: number;
  sessionId?: string;
  runId?: string;
  mode?: string;
  status?: string;
};

/**
 * Append a message to a live Cloud session (v4 POST /sessions/{id}/queue).
 * A session holds conversation history and keeps its browser, so the queued
 * text is handled on the already-open tab — this is how a code / correction /
 * «подожди» reaches the live login without starting a fresh browser.
 * `interrupt` cancels an active run so the message runs immediately.
 */
export async function queueMessage(
  sessionId: string,
  text: string,
  opts?: { interrupt?: boolean; attachedFileIds?: string[] },
): Promise<QueuedMessage> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("queueMessage: empty text");
  const body: Record<string, unknown> = { text: trimmed };
  if (opts?.interrupt) body.interrupt = true;
  if (opts?.attachedFileIds && opts.attachedFileIds.length > 0) {
    body.attachedFileIds = opts.attachedFileIds;
  }
  const res = await bu(`/sessions/${sessionId}/queue`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const id = typeof res.id === "number" ? res.id : undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    sessionId: pick(res, ["sessionId", "session_id"]) ?? sessionId,
    ...(pick(res, ["runId", "run_id"]) ? { runId: pick(res, ["runId", "run_id"]) } : {}),
    ...(pick(res, ["mode"]) ? { mode: pick(res, ["mode"]) } : {}),
    ...(pick(res, ["status"]) ? { status: pick(res, ["status"]) } : {}),
  };
}

export type SessionInfo = {
  sessionId: string;
  status: string;
  latestRunId?: string;
};

/** GET /sessions/{id}: session status + latest run id (for follow-through). */
export async function sessionInfo(
  sessionId: string,
): Promise<SessionInfo | undefined> {
  const res = await bu(`/sessions/${sessionId}`).catch(() => undefined);
  if (!res) return undefined;
  const latest = pick(res, ["latestRunId", "latest_run_id"]);
  return {
    sessionId: pick(res, ["sessionId", "session_id", "id"]) ?? sessionId,
    status: pick(res, ["status"]) ?? "unknown",
    ...(latest ? { latestRunId: latest } : {}),
  };
}

/**
 * After queueing into a session, find the run that will carry the follow-up.
 * The queued message may spawn a new run (new latestRunId) or resume the
 * existing one (same id, session goes active again). Wait briefly for either
 * so follow-through does not latch onto the just-finished run and report
 * "done" before the code was even applied.
 */
export async function resolveQueuedRun(
  sessionId: string,
  priorRunId: string | undefined,
  queued: QueuedMessage,
  opts?: { ms?: number; nowFn?: () => number },
): Promise<{ runId?: string; status?: string }> {
  const active = new Set([
    "queued",
    "pending",
    "dispatching",
    "running",
    "started",
    "in_progress",
    "working",
    "processing",
  ]);
  if (queued.runId && queued.runId !== priorRunId) {
    return { runId: queued.runId, ...(queued.status ? { status: queued.status } : {}) };
  }
  const now = opts?.nowFn ?? Date.now;
  const deadline = now() + (opts?.ms ?? 6_000);
  let last: SessionInfo | undefined;
  for (;;) {
    last = await sessionInfo(sessionId);
    if (last?.latestRunId && last.latestRunId !== priorRunId) {
      return { runId: last.latestRunId, status: last.status };
    }
    if (
      last?.latestRunId &&
      active.has(last.status.trim().toLowerCase())
    ) {
      return { runId: last.latestRunId, status: last.status };
    }
    if (now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const runId = last?.latestRunId ?? queued.runId ?? priorRunId;
  const status = last?.status;
  // Never hand back the just-finished/cancelled prior run as if it were the
  // follow-up: waitForRun would see a terminal status and report "done" before
  // the queued message ran. Report it as still running so the caller keeps
  // following (the background follow-through catches the real resumed run).
  if (runId === priorRunId && status && isTerminal(status)) {
    return { runId, status: "running" };
  }
  return { runId, ...(status ? { status } : {}) };
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

/**
 * POST /runs/{id}/cancel — idempotent, blocks further billing on that run.
 * https://docs.browser-use.com/cloud/api-v4/runs/cancel-run
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

/**
 * PATCH /browsers/{id} {"action":"stop"} — a completed run does not stop its
 * cloud browser on its own; stop it explicitly so a fresh errand gets a fresh
 * session instead of billing an abandoned one until the 4h hard cap.
 * https://docs.browser-use.com/cloud/api-v4/browsers/update-browser-session
 */
export async function stopBrowserForSession(sessionId: string): Promise<boolean> {
  try {
    const browser = await findBrowserForSession(sessionId);
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
  // Every other enrichment fetch below is already optional/`.catch()`-guarded;
  // this one is the one every caller treats as load-bearing, so a transient
  // Browser Use hiccup must degrade to "still looking", never throw mid-turn.
  const run = await bu(`/runs/${runId}`).catch((err: unknown) => {
    console.error("browser run fetch failed", err);
    return undefined;
  });
  if (!run) return { runId, sessionId, status: "unknown" };
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
  const rawResult =
    pick(run, ["result", "output"]) ??
    (typeof run.result === "object" && run.result
      ? JSON.stringify(run.result).slice(0, 2000)
      : undefined);
  const result = rawResult ? scrubSecrets(rawResult) : rawResult;
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

/**
 * Documented v4 run terminal states (completed|failed|cancelled) plus our own
 * `stalled` sentinel. Confirmed against docs.browser-use.com/cloud/api-v4 —
 * no `stopped`/`error`/`canceled` value is ever emitted by the API.
 */
export function isTerminal(status: string): boolean {
  return DONE.has(status.trim().toLowerCase());
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
