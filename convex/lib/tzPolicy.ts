/** Default when a tenant has no tz. Billing windows use the same zone. */
export const DEFAULT_TZ = "Europe/Moscow";

/**
 * Cabinet picker: official Russian zones (west → east) plus CIS capitals.
 * Backend still accepts any valid IANA name.
 */
export const CABINET_TIMEZONES = [
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Kamchatka",
  "Europe/Minsk",
  "Europe/Kyiv",
  "Europe/Chisinau",
  "Asia/Tbilisi",
  "Asia/Yerevan",
  "Asia/Baku",
  "Asia/Almaty",
  "Asia/Tashkent",
  "Asia/Bishkek",
  "Asia/Dushanbe",
  "Asia/Ashgabat",
] as const;


export type SessionTzChangeResult =
  | { ok: true; tz: string }
  | { ok: false; code: "unbound" | "invalid" };

/** Trim only — validation is separate. */
export function normalizeTz(tz: string): string {
  return tz.trim();
}

/** True when `tz` is a real IANA zone. Empty and garbage are false. */
export function isValidIanaTimeZone(tz: string): boolean {
  const name = normalizeTz(tz);
  if (!name) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Stored/agent tz, or Europe/Moscow when missing or garbage. */
export function resolveTenantTz(tz: string | undefined | null): string {
  if (typeof tz !== "string") return DEFAULT_TZ;
  const name = normalizeTz(tz);
  return isValidIanaTimeZone(name) ? name : DEFAULT_TZ;
}

/**
 * Session tz change: unbound (no phone) wins, then IANA check.
 * Does not write — caller runs the existing counter-carry path.
 */
export function sessionTzChangeDecision(opts: {
  phoneE164?: string;
  tz: string;
}): SessionTzChangeResult {
  if (!opts.phoneE164?.trim()) return { ok: false, code: "unbound" };
  const tz = normalizeTz(opts.tz);
  if (!isValidIanaTimeZone(tz)) return { ok: false, code: "invalid" };
  return { ok: true, tz };
}
