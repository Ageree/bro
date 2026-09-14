/**
 * Site login so Bro can reuse the Cloud profile later.
 * Vault password → Bro types via secretBindings. No match → live-view link.
 * Password never goes in iMessage.
 * https://docs.browser-use.com/cloud/guides/authentication
 */

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
Дождись формы входа и войди логином и паролем из сейфа.
Сфокусируй поле логина и попроси секрет \`site_login\`. Затем поле пароля и секрет \`site_password\`. Нажми войти.
После входа закончи одним словом: вошёл.
Никогда не читай и не переписывай значения. Не печатай пароль в чат.
Если форма просит код из SMS или почты — остановись и дай live-URL.`;
}

export function loginVaultChatText(site?: string): string {
  const where = site?.trim() ? ` в ${site.trim()}` : "";
  return `Сейчас войду${where} входом из сейфа. Сам напишу.`;
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
Дождись формы входа — ссылку человеку отправим только когда эта страница уже на экране.
Потом жди. Человек сам войдёт через live-view.
Ничего не вводи: ни логин, ни пароль, ни код из SMS. Не нажимай «войти» за него.
Когда увидишь личный кабинет, имя или заказы — закончи одним словом: вошёл.
Если прошло несколько минут и входа нет — закончи: ещё не вошёл.`;
}

/** First bubble while the Cloud browser still opens the login page. */
export function loginOpeningText(site?: string): string {
  const where = site?.trim() ? ` в ${site.trim()}` : "";
  return `Открываю вход${where} — ссылка сейчас придёт.`;
}

/** iMessage copy. URL on its own line. */
export function loginChatText(liveUrl: string, site?: string): string {
  const where = site?.trim() ? ` в ${site.trim()}` : "";
  return `Открой ссылку и войди${where}. Bro пароль не увидит — вход сохранится сам.\n\n${liveUrl.trim()}`;
}

/** First bubble when Cloud cookies already cover this site. No live-view. */
export function alreadyLoggedChatText(site?: string): string {
  const where = site?.trim() ? ` в ${site.trim()}` : "";
  return `Вход${where} уже сохранён — ссылку не присылаю, дальше сделаю сам.`;
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
