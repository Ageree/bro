import type { DynamicResolveContext } from "eve/instructions";
import { describe, expect, it, vi } from "vitest";
import browser from "@agent/instructions/content/browser/available.md?raw";

describe("public-service instructions", () => {
  it("reads meter photos by tariff, serial number and whole units", async () => {
    // RU d08: readings from the photos were never staged; mixed-up T1 and
    // T2 are an error.
    const content = await resolveContent("telegram-webhook", "bu-key");

    expect(content).toContain("его заводской номер");
    expect(content).toContain(
      "Красные цифры и всё после запятой — доли (у воды это литры)"
    );
    expect(content).toContain("Т1 (день) и Т2 (ночь)");
    expect(content).toContain("«Т» или «Σ» без номера — сумма тарифов");
    expect(content).toContain(
      "Показание меньше прошлого или подозрительный скачок — переспроси одним вопросом до передачи"
    );
  });

  it("stages the readings and asks once, on a card with the values", async () => {
    const content = await resolveContent("telegram-webhook", "bu-key");

    expect(content).toContain("дойди до кнопки передачи и остановись");
    expect(content).toContain("в `what` — все показания с номерами счётчиков");
    expect(content).toContain("Это одна карточка на сайт.");
    expect(content).toContain("сначала почта");
  });

  it("routes Госуслуги errands and doctors to the right cabinet", async () => {
    const content = await resolveContent("photon-imessage", "bu-key");

    expect(content).toContain("каждое начисление с тем, за что оно");
    expect(content).toContain(
      "ЕМИАС (emias.info или mos.ru, вход через Госуслуги)"
    );
    expect(browser).toContain(
      "Сохранённый вход на Госуслуги открывает и госсайты с кнопкой «Войти через Госуслуги»"
    );
    expect(browser).toContain(
      "Входит так запуск только на сайт своего поручения, а не на запасные сайты, магазины и банки с той же кнопкой."
    );
    expect(browser).toContain(
      "«Висит 500 ₽ к оплате» без того, за что, — не ответ."
    );
    expect(browser).toContain("в том же ходе ставь в его календарь");
  });

  it("never sends document numbers to a fines check without a card", async () => {
    // Review: «Штрафы ГИБДД по СТС и ВУ без входа» put both numbers into a
    // run with no card, headed for whatever site the search reached.
    const content = await resolveContent("telegram-webhook", "bu-key");

    expect(content).not.toContain("Штрафы ГИБДД по СТС и ВУ без входа");
    expect(content).toContain(
      "номера документов на сайт уходят только по карточке, а на чужой сайт — никогда"
    );
    expect(content).toContain("https://xn--90adear.xn--p1ai/check/fines");
  });

  it("does without Госуслуги what it can, and warns of the code up front", async () => {
    // RU 25.09, d06: Bro offered to look in the mail «если хотите», and the
    // code request came a quarter of an hour after the start, unannounced.
    const content = await resolveContent("telegram-webhook", "bu-key");

    expect(content).toContain(
      "срок документа сам ищи в почте и на Диске (`gmail-search`, `drive-search`), а не предлагай поискать"
    );
    expect(content).toContain(
      "сразу скажи, что для входа придёт код по SMS или в Max"
    );
  });

  it("keeps «найди билеты» a search, on the seller's own site", () => {
    expect(browser).toContain(
      "«найди» остаётся поиском, даже если человек назвал место («у прохода») или регистрацию"
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
