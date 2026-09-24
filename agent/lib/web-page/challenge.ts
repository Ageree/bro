/**
 * What a page that checks for bots says in place of the content: the title
 * and heading of a Cloudflare, DDoS-Guard, Qrator or Yandex SmartCaptcha
 * page. `find_images` looks for it in the page title, `web_fetch` at the top
 * of the Markdown it got back.
 */
export const challengeWording =
  /just a moment|attention required|access denied|verification required|checking your browser|доступ ограничен|доступ запрещ|вы не робот|are you a robot|подтвердите, что вы человек|подтвердите, что запросы отправляли вы|проверка браузера|captcha/iu;
