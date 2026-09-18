import { env } from "@shared/environment";

function calendarParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return { day: value("day"), month: value("month"), year: value("year") };
}

/** `2026-09-18` on the workspace's own wall clock. */
export function localDayKey(now: Date, timeZone: string) {
  const { day, month, year } = calendarParts(now, timeZone);
  return `${year}-${month}-${day}`;
}

/** `2026-09` on the workspace's own wall clock. */
export function localMonthKey(now: Date, timeZone: string) {
  const { month, year } = calendarParts(now, timeZone);
  return `${year}-${month}`;
}

export function messageAllowance(paid: boolean) {
  return paid ? env.PAID_MESSAGES_PER_DAY : env.FREE_MESSAGES_PER_DAY;
}

export function browserRunAllowance(paid: boolean) {
  return paid
    ? env.PAID_BROWSER_RUNS_PER_MONTH
    : env.FREE_BROWSER_RUNS_PER_MONTH;
}

/**
 * `count` already includes the action being decided, so an allowance of 30
 * delivers thirty messages and turns the thirty-first away.
 */
export function withinAllowance(count: number, allowance: number) {
  return count <= allowance;
}

/** Wording the person sees when the day's messages run out. */
export function messagePaywallText(payUrl: string | undefined) {
  const price = `${String(env.PRICE_RUB)} ₽/мес`;
  return payUrl
    ? `Лимит сообщений на сегодня исчерпан 🙈 Полный доступ — ${price}: ${payUrl}`
    : "Лимит сообщений на сегодня исчерпан 🙈 Завтра счётчик обнулится.";
}

/** Wording the model gets when the month's browser errands run out. */
export function browserQuotaNote(payUrl: string | undefined) {
  const price = `${String(env.PRICE_RUB)} ₽/мес`;
  return payUrl
    ? `Лимит браузерных поручений на этот месяц исчерпан. Поручение не запущено. Скажи человеку об этом и дай ссылку на оплату — ${price}: ${payUrl}`
    : "Лимит браузерных поручений на этот месяц исчерпан. Поручение не запущено. Скажи человеку, что лимит вернётся в начале следующего месяца.";
}
