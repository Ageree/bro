import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  closedBy,
  doneLabel,
  endedText,
  goneText,
  liveHint,
  noticeText,
  problemText,
  startingText,
} from "../copy";
import { Intro } from "../intro";
import { Viewer } from "../viewer";

describe("the sign-in window's words", () => {
  it("says what the screen is, where to sign in and that Bro does not read the password", () => {
    const html = renderToStaticMarkup(
      <Intro domain="passport.yandex.ru" onStart={() => undefined} />
    );
    expect(html).toContain("Вход на passport.yandex.ru");
    expect(html).toContain("Ниже откроется окно компьютера Бро");
    expect(html).toContain("Вы управляете им прямо отсюда");
    expect(html).toContain("Войдите в свой аккаунт на passport.yandex.ru.");
    expect(html).toContain("Бро не читает и не сохраняет ваш пароль");
    // The intro names the button the live window really has.
    expect(html).toContain(`«${doneLabel}»`);
    expect(liveHint).toContain(`«${doneLabel}»`);
    expect(html).toContain("Начать");
  });

  it("opens on a loading line before it reads the link", () => {
    expect(renderToStaticMarkup(<Viewer id="x" />)).toContain("Открываю…");
  });

  it("speaks of the sign-in page, not of a browser, while it works", () => {
    expect(startingText).toBe(
      "Открываю страницу входа. Обычно это несколько секунд, иногда до минуты…"
    );
    expect(noticeText.error).toBe("Страница не отвечает, пробую ещё раз…");
    expect(endedText.yes).toContain("вход сохранён, дальше Бро справится сам");
  });

  it("tells a window whose time ran out from one the person cancelled", () => {
    expect(closedBy.expired).toBe("expired");
    expect(endedText[closedBy.expired]).toContain("Время окна вышло");
    expect(closedBy.cancel).toBe("cancelled");
    expect(endedText[closedBy.cancel]).toContain("вход не сохранён");
    // A window that broke off is a failure, not «time ran out».
    expect(endedText.failed).toContain(
      "Окно закрылось раньше, чем вход завершился"
    );
    expect(endedText.failed).not.toContain("Время");
  });

  it("tells the person what to do next in every dead end", () => {
    expect(goneText.expired).toContain("пришли новую ссылку для входа");
    expect(goneText.taken).toContain("уже открыли на другом устройстве");
    expect(goneText.ended).toContain("он пришлёт новую ссылку");
    expect(goneText.missing).toContain("попросите Бро прислать новую");
    expect(problemText.busy).toContain("Подождите минуту и попробуйте ещё раз");
    expect(problemText.failed).toContain("Попробуйте ещё раз через минуту");
    expect(problemText.unsupported).toContain("предложит другой способ войти");
    expect(endedText.no).toContain("сайт всё ещё просит войти");
  });
});
