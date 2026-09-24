import { describe, expect, it } from "vitest";
import autonomy from "@agent/instructions/content/autonomy.md?raw";
import browser from "@agent/instructions/content/browser/available.md?raw";

describe("carrying an errand through", () => {
  it("sets up a later step of the person's goal at once", () => {
    // RU 24.09: d02 left check-in to the person, d08 never passed the
    // readings, d18 stopped after its first step.
    expect(autonomy).toContain("## Дело до конца");
    expect(autonomy).toContain(
      "Часть дела, которую можно сделать только позже, ставь сразу, а не заканчивай «напиши, если нужно»"
    );
    expect(autonomy).toContain("Момент узнай, а не угадывай");
    expect(browser).toContain("он вернёт это в `Next`");
  });

  it("schedules nothing the person did not ask for", () => {
    expect(autonomy).toContain(
      "Расписание — только для шага того дела, которое человек сам поручил в этом разговоре."
    );
  });

  it("answers «ну что там?» from the outcome, not with a new run", () => {
    expect(browser).toContain("«Ну что там?», «как там?» про поручение");
    expect(browser).toContain(
      "спрашивать у запуска, как дела, через `continue` нельзя"
    );
  });

  it("sends a delivery errand out with the address and a repeat order to the site's history", () => {
    expect(browser).toContain(
      "ставь `deliveryAddress: true` уже на первом `start`"
    );
    expect(browser).toContain("найдёт покупку в его истории заказов");
  });
});
