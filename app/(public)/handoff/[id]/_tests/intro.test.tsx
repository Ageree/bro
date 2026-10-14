import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { closedBy, doneLabel, endedText, liveHint } from "../copy";
import { Intro } from "../intro";

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
});
