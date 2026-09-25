import type { DynamicResolveContext } from "eve/instructions";
import { describe, expect, it } from "vitest";
import browser from "@agent/instructions/content/browser/available.md?raw";
import publicServices from "@agent/instructions/45-public-services";

describe("public-service instructions", () => {
  it("reads meter photos by tariff, serial number and whole units", async () => {
    // RU d08: readings from the photos were never staged; mixed-up T1 and
    // T2 are an error.
    const content = await resolveContent("telegram-webhook");

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
    const content = await resolveContent("telegram-webhook");

    expect(content).toContain("дойди до кнопки передачи и остановись");
    expect(content).toContain("в `what` — все показания с номерами счётчиков");
    expect(content).toContain("Это одна карточка на сайт.");
    expect(content).toContain("сначала почта");
  });

  it("routes Госуслуги errands and doctors to the right cabinet", async () => {
    const content = await resolveContent("photon-imessage");

    expect(content).toContain("каждое начисление с тем, за что оно");
    expect(content).toContain(
      "ЕМИАС (emias.info или mos.ru, вход через Госуслуги)"
    );
    expect(browser).toContain(
      "Сохранённый вход на Госуслуги открывает и госсайты с кнопкой «Войти через Госуслуги»"
    );
    expect(browser).toContain(
      "«Висит 500 ₽ к оплате» без того, за что, — не ответ."
    );
    expect(browser).toContain("в том же ходе ставь в его календарь");
  });

  it("stays out of background workers and reports", async () => {
    expect(await resolveContent("scheduled-worker")).toBeUndefined();
    expect(await resolveContent("scheduled-result")).toBeUndefined();
  });
});

async function resolveContent(authenticator: string) {
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
