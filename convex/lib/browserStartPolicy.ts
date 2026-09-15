/**
 * Cloud v4 POST /runs has no startUrl. Eve opens the real tab over CDP
 * after browser.ready — for login and for errands (taxi, shops).
 */

import { loginPageUrl } from "./browserProfilePolicy.ts";

/** How long browser_task waits for the site after ready (CDP, not the LLM). */
export const ERRAND_LANDING_WAIT_MS = 25_000;

const TAXI_PAGE = "https://taxi.yandex.ru/";
const OZON_PAGE = "https://www.ozon.ru/";
const WB_PAGE = "https://www.wildberries.ru/";

/**
 * Page eve must open immediately. Explicit https in the task wins;
 * otherwise taxi / Ozon / WB from the wording.
 */
export function errandStartUrl(task: string | undefined): string | undefined {
  const match = task?.match(/https?:\/\/[^\s<>"']+/);
  const fromTask = match
    ? loginPageUrl(match[0].replace(/[),.;]+$/g, ""))
    : loginPageUrl(task);
  if (fromTask) return fromTask;
  const text = task?.trim() ?? "";
  if (!text) return undefined;
  if (/(такси|taxi\.yandex|яндекс\.?\s*такси|yandex\s*taxi)/i.test(text)) {
    return TAXI_PAGE;
  }
  if (/\bozon\b|озон/i.test(text)) return OZON_PAGE;
  // \b is ASCII-only in JS regex — it never forms directly against a
  // Cyrillic letter, so a bare «вб» could never match here. Same fix as
  // agent/lib/order-policy.ts merchantFromTask.
  if (
    /\bwildberries\b|вайлдберриз/i.test(text) ||
    /(?:^|[^\p{L}])(?:wb|вб)(?:[^\p{L}]|$)/iu.test(text)
  ) {
    return WB_PAGE;
  }
  return undefined;
}
