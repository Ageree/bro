import type { DynamicResolveContext } from "eve/instructions";
import { describe, expect, it, vi } from "vitest";
import browser from "@agent/instructions/content/browser/available.md?raw";

describe("public-service instructions", () => {
  it("sends delegated readings at once across report continuations without cards", async () => {
    const content = await resolveContent("telegram-webhook", "bu-key");

    expect(content).toContain(
      "Показания, которые человек прислал, передавай сразу, без вопроса и без карточки."
    );
    expect(content).toContain(
      "Они уходят сразу и в продолжении того же поручения после отчёта браузера, без карточки и повторного вопроса."
    );
  });

  it("lets the saved Госуслуги login open only the errand's own site", () => {
    expect(browser).toContain(
      "Сохранённый вход на Госуслуги открывает и госсайты с кнопкой «Войти через Госуслуги»"
    );
    expect(browser).toContain(
      "Входит так запуск только на сайт своего поручения, а не на запасные сайты, магазины и банки с той же кнопкой."
    );
  });

  it("keeps document numbers on the explicitly requested site without extra approval", async () => {
    // Review: «Штрафы ГИБДД по СТС и ВУ без входа» put both numbers into a
    // run with no card, headed for whatever site the search reached.
    const content = await resolveContent("telegram-webhook", "bu-key");

    expect(content).not.toContain("Штрафы ГИБДД по СТС и ВУ без входа");
    expect(content).toContain(
      "номера документов используй на сайте поручения, если человек попросил это сделать, без карточки; на чужой сайт их не отправляй"
    );
    expect(content).toContain("https://xn--90adear.xn--p1ai/check/fines");
  });

  it("keeps «найди билеты» a search, on the seller's own site", () => {
    expect(browser).toContain(
      '«найди» и «сколько стоит» остаются поиском (`personWants: "look"`), даже если человек назвал место («у прохода») или регистрацию'
    );
    expect(browser).toContain(
      "В `site` ставь сайт перевозчика или продавца, где будет покупка"
    );
    expect(browser).not.toContain("это покупка, даже если он написал «найди»");
  });

  it("leaves the site errands out where there is no browser", async () => {
    // Review: without Browser Use the model heard «передай показания
    // поручением» next to «этот деплой не умеет работать с сайтом».
    const content = await resolveContent("telegram-webhook", "");

    expect(content).toContain("Т1 (день) и Т2 (ночь)");
    expect(content).toContain("сначала почта");
    expect(content).not.toContain("`allowSubmit`");
    expect(content).not.toContain("ЕМИАС");
    expect(content).not.toContain("Госуслугах");
  });

  it("stays out of background workers and reports", async () => {
    expect(await resolveContent("scheduled-worker", "bu-key")).toBeUndefined();
    expect(await resolveContent("scheduled-result", "bu-key")).toBeUndefined();
  });
});

// The Browser Use key is read from the environment, so each expectation
// loads the instruction module against the state it describes.
async function resolveContent(authenticator: string, browserUseKey: string) {
  vi.resetModules();
  vi.stubEnv("BROWSER_USE_API_KEY", browserUseKey);
  const { default: publicServices } =
    await import("@agent/instructions/45-public-services");
  const resolve = publicServices.events["turn.started"];
  if (!resolve)
    throw new Error("Public-service instructions resolve per turn.");
  const selected = await resolve({}, dynamicContext(authenticator));
  return selected?.content;
}

function dynamicContext(authenticator: string) {
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current: {
          attributes: {},
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}
