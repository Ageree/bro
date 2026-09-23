import { env } from "@shared/environment";

export function messageAllowance(paid: boolean) {
  return paid ? env.PAID_MESSAGES_PER_DAY : env.FREE_MESSAGES_PER_DAY;
}

export function browserRunAllowance(paid: boolean) {
  return paid
    ? env.PAID_BROWSER_RUNS_PER_MONTH
    : env.FREE_BROWSER_RUNS_PER_MONTH;
}

export function imageGenerationAllowance(paid: boolean) {
  return paid
    ? env.PAID_IMAGE_GENERATIONS_PER_MONTH
    : env.FREE_IMAGE_GENERATIONS_PER_MONTH;
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

/** Wording the model gets when the month's pictures run out. */
export function imageQuotaNote(payUrl: string | undefined) {
  const price = `${String(env.PRICE_RUB)} ₽/мес`;
  return payUrl
    ? `Лимит картинок на этот месяц исчерпан. Картинка не нарисована. Скажи человеку об этом и дай ссылку на оплату — ${price}: ${payUrl}`
    : "Лимит картинок на этот месяц исчерпан. Картинка не нарисована. Скажи человеку, что лимит вернётся в начале следующего месяца.";
}
