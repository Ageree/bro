/**
 * Proxyless Cloud (AWS US) vs managed RU residential.
 * 2026-09-06 live trial: WB search worked without a proxy; Ozon died
 * ("нет соединения"); Avito IP-blocked; Yandex Market search → SmartCaptcha;
 * Yandex Taxi/Go homepage loads, then "Город Колумбус не поддерживается".
 */

const PROXY_FIRST =
  /ozon(\.ru)?|озон|avito(\.ru)?|авито|taxi\.yandex|go\.yandex|яндекс\s*такси|яндекс\s*go|yandex\s*(go|taxi)/i;

const BLOCK =
  /нет соединения|нет\s+сети|похож[её],?\s+нет соедин|отключ(и|ите)\s+vpn|выключ(и|ите)\s+vpn|disable(?: your)? vpn|доступ ограничен|проблема с ip|smartcaptcha|я не робот|cloudflare|ddos-guard|access denied|unusual traffic|checking your browser|try disabling|не поддерживается сервисом|город .{0,60}не поддержива/i;

export function shouldStartWithManagedProxy(task: string): boolean {
  return PROXY_FIRST.test(task);
}

export function needsProxyRetry(result: string | undefined): boolean {
  if (!result) return false;
  return BLOCK.test(result);
}

/** BYOP or an explicit country already is a proxy hop — do not add a second. */
export function proxyFallbackEnabled(
  env: {
    BRO_BROWSER_PROXY_FALLBACK?: string;
    BRO_BROWSER_PROXY_HOST?: string;
  } = process.env,
): boolean {
  if (env.BRO_BROWSER_PROXY_FALLBACK?.trim() === "0") return false;
  if (env.BRO_BROWSER_PROXY_HOST?.trim()) return false;
  return true;
}

export function firstHopUsesManagedProxy(
  task: string,
  env: {
    BRO_BROWSER_PROXY_FALLBACK?: string;
    BRO_BROWSER_PROXY_HOST?: string;
    BROWSERUSE_PROXY_COUNTRY?: string;
    BRO_BROWSER_PROXY?: string;
  } = process.env,
): boolean {
  if (!proxyFallbackEnabled(env)) {
    const country = (
      env.BROWSERUSE_PROXY_COUNTRY ??
      env.BRO_BROWSER_PROXY ??
      "none"
    )
      .trim()
      .toLowerCase();
    return Boolean(country) && country !== "none";
  }
  if (env.BROWSERUSE_PROXY_COUNTRY?.trim()) return true;
  const fallback = env.BRO_BROWSER_PROXY?.trim().toLowerCase();
  if (fallback && fallback !== "none") return true;
  return shouldStartWithManagedProxy(task);
}
