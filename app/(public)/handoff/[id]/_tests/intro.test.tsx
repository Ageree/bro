import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { doneLabel, endedText, goneText, problemText } from "../copy";
import { Intro } from "../intro";
import { Viewer } from "../viewer";

describe("the sign-in window's words", () => {
  it("says what the screen is, where to sign in and who sees the password", () => {
    const html = renderToStaticMarkup(
      <Intro domain="passport.yandex.ru" onStart={() => undefined} />
    );
    expect(html).toContain("Вход на passport.yandex.ru");
    expect(html).toContain("окно компьютера Бро");
    expect(html).toContain("Войдите в свой аккаунт на passport.yandex.ru.");
    expect(html).toContain("Бро их не видит и не хранит");
    // The intro names the button the live window really has.
    expect(html).toContain(`«${doneLabel}»`);
    expect(html).toContain("Начать");
  });

  it("opens on a loading line before it reads the link", () => {
    expect(renderToStaticMarkup(<Viewer id="x" />)).toContain("Открываю…");
  });

  it("tells the person what to do next in every dead end", () => {
    for (const text of [
      ...Object.values(goneText),
      ...Object.values(problemText),
      endedText.cancelled,
      endedText.expired,
      endedText.failed,
      endedText.no,
    ]) {
      expect(text).toMatch(/Бро|ещё раз/u);
    }
  });
});
