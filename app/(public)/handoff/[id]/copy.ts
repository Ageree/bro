/**
 * What the sign-in window says to the person, who most often came from a chat
 * and has never seen Bro's browser: what this screen is, what to do in it and
 * what each state means. Bro does not see the password: the window passes
 * keys to the page, keeps nothing, and the browser's password manager is off
 * (`browser-vm/image/provision.sh`).
 */

/** The button under the window that ends the sign-in. */
export const doneLabel = "Готово — я вошёл";

export const introText = {
  control:
    "Ниже откроется окно компьютера Бро — его браузер, в котором он делает ваши дела на сайтах. Вы управляете им прямо отсюда: нажимайте на поля и кнопки и печатайте как обычно, с телефона тоже.",
  password:
    "Логин, пароль и код из СМС вводите в окне — они уходят прямо на сайт. Бро не читает и не сохраняет ваш пароль: у него остаётся только сам вход, как в браузере, где вы не нажали «Выйти».",
  remember: `Если сайт предлагает «Запомнить меня» — отметьте, вход продержится дольше. Когда войдёте, нажмите «${doneLabel}» под окном.`,
  share: "Ссылка открывается на одном устройстве. Никому её не пересылайте.",
  signIn: (domain: string) => `Войдите в свой аккаунт на ${domain}.`,
} as const;

/** One line over the live window, for whoever skipped the intro. */
export const liveHint = `Это окно компьютера Бро: нажимайте и печатайте прямо в нём. Вошли — нажмите «${doneLabel}» внизу.`;

export const loadingText = "Открываю…";
export const startingText =
  "Открываю страницу входа. Обычно это несколько секунд, иногда до минуты…";
export const framingText = "Загружаю страницу…";
export const finishingText = "Сохраняю вход…";

export const goneText = {
  ended:
    "Это окно уже закрыто. Если войти не получилось, напишите Бро — он пришлёт новую ссылку.",
  expired:
    "Ссылка устарела: она живёт недолго, чтобы ей никто не воспользовался. Напишите Бро «пришли новую ссылку для входа».",
  missing:
    "Такой ссылки нет. Проверьте, что открыли её целиком, или попросите Бро прислать новую.",
  taken:
    "Эту ссылку уже открыли на другом устройстве. Если это были не вы, напишите Бро — он пришлёт новую.",
} as const;

/** A problem the person can try again from the same page. */
export const problemText = {
  busy: "Бро сейчас занят другим вашим делом. Подождите минуту и попробуйте ещё раз.",
  failed:
    "Не получилось открыть окно. Попробуйте ещё раз через минуту; не выйдет — напишите Бро.",
  unsupported:
    "Окно входа сейчас не работает. Напишите Бро — он предложит другой способ войти.",
} as const;

export const retryLabel = "Попробовать ещё раз";

export const endedText = {
  cancelled:
    "Окно закрыто, вход не сохранён. Передумаете — попросите Бро прислать ссылку снова.",
  expired:
    "Время окна вышло, и оно закрылось. Попросите Бро прислать новую ссылку — займёт минуту.",
  failed:
    "Окно закрылось раньше, чем вход завершился. Попросите Бро прислать новую ссылку.",
  no: "Похоже, сайт всё ещё просит войти. Напишите Бро — он пришлёт новую ссылку.",
  unknown:
    "Готово. Бро проверит вход, когда в следующий раз пойдёт на этот сайт. Возвращайтесь в чат.",
  yes: "Готово: вход сохранён, дальше Бро справится сам. Окно можно закрыть и вернуться в чат.",
} as const;

/**
 * How the window ended when the browser closed it: the person's own cancel,
 * or the window's time running out. A fault is not either of these.
 */
export const closedBy = {
  cancel: "cancelled",
  expired: "expired",
} as const satisfies Record<string, keyof typeof endedText>;

export const noticeText = {
  blocked: (host: string) =>
    `Переход на ${host} закрыт: это не тот сайт, куда вы входите.`,
  error: "Страница не отвечает, пробую ещё раз…",
  popup:
    "Открылось окно входа (например, через Яндекс или VK). Оно показано здесь же.",
} as const;
