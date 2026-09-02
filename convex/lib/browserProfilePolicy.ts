/**
 * Browser Use Cloud login: the human opens a live link, signs in themselves,
 * cookies stay on their Cloud profile. The agent never sees the password.
 * https://docs.browser-use.com/cloud/guides/authentication
 */

export const LOGIN_MARK = "[bro-login]";

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

/** Cloud-agent instructions: open the page and wait. Never type secrets. */
export function loginWaitTask(url: string): string {
  const page = loginPageUrl(url);
  if (!page) throw new Error("нужна обычная ссылка на сайт");
  return `${LOGIN_MARK}
Открой ${page} и жди. Человек сам войдёт через live-view.
Ничего не вводи: ни логин, ни пароль, ни код из SMS. Не нажимай «войти» за него.
Когда увидишь личный кабинет, имя или заказы — закончи одним словом: вошёл.
Если прошло несколько минут и входа нет — закончи: ещё не вошёл.`;
}

/** iMessage copy. URL on its own line. */
export function loginChatText(liveUrl: string, site?: string): string {
  const where = site?.trim() ? ` в ${site.trim()}` : "";
  return `Открой ссылку и войди${where}. Bro пароль не увидит — вход сохранится сам.\n\n${liveUrl.trim()}`;
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
