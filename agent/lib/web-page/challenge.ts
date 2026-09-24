/**
 * What a page that asks the visitor to prove they are human says in place of
 * the content: the title and heading of a Cloudflare, DDoS-Guard, Qrator or
 * Yandex SmartCaptcha check. A standalone «captcha» only: «reCAPTCHA» and
 * «hCaptcha» name the widget under a real form.
 */
export const botCheckWording =
  /just a moment|verification required|checking your browser|вы не робот|are you a robot|подтвердите, что вы человек|подтвердите, что запросы отправляли вы|проверка браузера|(?<!\p{L})captcha/iu;

/**
 * A bot check or a block page. A block page's words («Доступ запрещён»,
 * «Access denied») can also head a real article, so they count only in a
 * page title (`find_images`) or on a page that came with an error status
 * (`web_fetch`).
 */
export const challengeWording = new RegExp(
  `${botCheckWording.source}|attention required|access denied|доступ ограничен|доступ запрещ`,
  "iu"
);
