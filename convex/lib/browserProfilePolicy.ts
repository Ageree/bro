/**
 * Site login so Bro can reuse the Cloud profile later.
 * Vault password → Bro types via secretBindings. No match → live-view link.
 * Password never goes in iMessage.
 * https://docs.browser-use.com/cloud/guides/authentication
 */

import { loginHostsMatch } from "./browserLivePolicy.ts";
import { DONE } from "./browserFollowPolicy.ts";

export const LOGIN_MARK = "[bro-login]";
export const LOGIN_VAULT_MARK = "[bro-vault-login]";

export function isLoginWaitTask(task: string | undefined): boolean {
  return typeof task === "string" && task.trim().startsWith(LOGIN_MARK);
}

export function isLoginVaultTask(task: string | undefined): boolean {
  return typeof task === "string" && task.trim().startsWith(LOGIN_VAULT_MARK);
}

export function loginVaultTask(url: string): string {
  const page = loginPageUrl(url);
  if (!page) throw new Error("нужна обычная ссылка на сайт");
  return `${LOGIN_VAULT_MARK}
Первым действием открой именно ${page} (сразу navigate, не about:blank и не стартовая Browser Use).
Видишь «Войти» или «Авторизоваться» — нажми, чтобы открылась форма входа (паспорт — нормально).
На форме сфокусируй поле логина и попроси секрет \`site_login\`, затем поле пароля и секрет \`site_password\`, и нажми войти. Значения ты не видишь, их вводит сервер.
Вошёл — закончи одним словом: вошёл.
Форма просит код из SMS или почты — остановись и дай live-URL.`;
}

export function loginVaultChatText(site?: string): string {
  const where = site?.trim() ? ` в ${site.trim()}` : "";
  return `Захожу${where} сам — вход у меня сохранён. Напишу, как войду.`;
}

export function loginPageFromTask(task: string | undefined): string | undefined {
  if (!task) return undefined;
  const match = task.match(/https?:\/\/\S+/);
  return loginPageUrl(match?.[0]);
}

export function siteFromLoginTask(task: string | undefined): string | undefined {
  const page = loginPageFromTask(task);
  if (!page) return undefined;
  try {
    return new URL(page).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

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

export function loginPageUrl(raw: string | undefined): string | undefined {
  const text = raw?.trim() ?? "";
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Cloud-agent instructions: open the login first, then wait. Person types secrets in live-view. */
export function loginWaitTask(url: string): string {
  const page = loginPageUrl(url);
  if (!page) throw new Error("нужна обычная ссылка на сайт");
  return `${LOGIN_MARK}
Первым действием открой именно ${page} (сразу navigate, не about:blank и не стартовая Browser Use).
Уже видно личный кабинет, имя или заказы — закончи одним словом: вошёл.
Видишь «Войти» или «Авторизоваться» — нажми, чтобы открылась форма входа (паспорт — нормально).
Дождись формы входа на экране: ссылка человеку уйдёт только тогда.
Дальше жди. Пароль человек введёт сам в live-view, а одноразовый код может прислать в чат — его введёт Bro.
Не вводи логин и пароль сам и не подтверждай форму, пока их нет. Пароль в iMessage не проси.
Появился личный кабинет, имя или заказы — закончи одним словом: вошёл.
Прошло несколько минут и входа нет — закончи: ещё не вошёл.`;
}

/** First bubble while the Cloud browser still opens the login page. */
export function loginOpeningText(site?: string): string {
  const where = site?.trim() ? ` в ${site.trim()}` : "";
  return `Открываю вход${where}, сейчас скину ссылку.`;
}

/** iMessage copy. URL on its own line. */
export function loginChatText(liveUrl: string, site?: string): string {
  const where = site?.trim() ? ` в ${site.trim()}` : "";
  return `Вот ссылка — зайди${where} сам. Пароль я не увижу, вход дальше сохранится.\n\n${liveUrl.trim()}`;
}

/** First bubble when Cloud cookies already cover this site. No live-view. */
export function alreadyLoggedChatText(site?: string): string {
  const where = site?.trim() ? ` в ${site.trim()}` : "";
  return `Вход${where} у меня уже сохранён, ссылка не нужна — дальше сам.`;
}

function cookieHost(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  try {
    if (text.includes("://")) {
      const host = new URL(text).hostname.replace(/^www\./, "").toLowerCase();
      return host || undefined;
    }
  } catch {
    return undefined;
  }
  const host = text.replace(/^\./, "").replace(/^www\./, "").toLowerCase();
  return host || undefined;
}

function registrableHost(host: string): string {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

const IDENTITY_HEAD = new Set([
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
]);

/**
 * True when the Cloud profile already has cookies for this login page
 * (same host, parent domain, or the site's identity host).
 */
export function cookieDomainsCoverPage(
  domains: readonly string[] | undefined,
  pageUrl: string,
): boolean {
  const page = cookieHost(pageUrl);
  if (!page || !domains?.length) return false;
  const pageReg = registrableHost(page);
  const pageHead = page.split(".")[0] ?? "";
  for (const raw of domains) {
    const domain = cookieHost(raw);
    if (!domain) continue;
    if (page === domain || page.endsWith(`.${domain}`)) return true;
    const domainReg = registrableHost(domain);
    if (pageReg !== domainReg) continue;
    const domainHead = domain.split(".")[0] ?? "";
    if (
      IDENTITY_HEAD.has(pageHead) ||
      IDENTITY_HEAD.has(domainHead) ||
      domain === pageReg ||
      page === pageReg
    ) {
      return true;
    }
  }
  return false;
}

export function profileSyncStatus(opts: {
  profileId?: string;
  cookieDomains?: readonly string[];
}): "missing" | "empty" | "synced" {
  if (!normalizeBrowserProfileId(opts.profileId)) return "missing";
  return (opts.cookieDomains?.length ?? 0) > 0 ? "synced" : "empty";
}

/** profile_setup must not abandon a login it already has in flight (A3 F2):
 *  a still-active run for the same login page, started recently, is polled
 *  instead of starting a brand-new browser/run. */
export const LOGIN_REUSE_WINDOW_MS = 15 * 60_000;

export function nextLoginAction(opts: {
  runId?: string;
  status?: string;
  storedTask?: string;
  startedAt?: number;
  page: string;
  now: number;
}): "start" | "reuse" {
  if (!opts.runId) return "start";
  if (!isLoginWaitTask(opts.storedTask)) return "start";
  if (DONE.has((opts.status ?? "").trim().toLowerCase())) return "start";
  const taskPage = loginPageFromTask(opts.storedTask);
  if (!taskPage || !loginHostsMatch(taskPage, opts.page)) return "start";
  if (
    typeof opts.startedAt !== "number" ||
    opts.now - opts.startedAt >= LOGIN_REUSE_WINDOW_MS
  ) {
    return "start";
  }
  return "reuse";
}

/** A cached "cookies cover this page" verdict must not be trusted forever
 *  (A3 F7): a run that just reported needing a password invalidates it
 *  outright, and otherwise it is refreshed once a day. */
const COOKIE_CACHE_TTL_MS = 24 * 3600_000;

export function cookieCacheStale(
  tenant: { browserProfileSyncedAt?: number; browserNeed?: string },
  now: number,
): boolean {
  if (tenant.browserNeed === "password") return true;
  if (typeof tenant.browserProfileSyncedAt !== "number") return false;
  return now - tenant.browserProfileSyncedAt > COOKIE_CACHE_TTL_MS;
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
