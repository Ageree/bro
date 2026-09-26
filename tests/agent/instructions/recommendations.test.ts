import type { DynamicResolveContext } from "eve/instructions";
import { describe, expect, it } from "vitest";
import recommendations from "@agent/instructions/25-recommendations";

describe("recommendation instructions", () => {
  it("checks every condition against a source and says what it could not check", async () => {
    for (const authenticator of ["photon-imessage", "scheduled-worker"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One role at a time keeps the failure readable.
      const content = await resolveContent(authenticator);
      expect(content).toContain("каждое названное условие обязательно");
      expect(content).toContain(
        "Проверенным считай то, что показал результат инструмента в этом разговоре: выдача `web_search`, страница `web_fetch`, отчёт браузерного запуска"
      );
      expect(content).toContain("ссылка на источник");
      expect(content).toContain("Догадку за факт не выдавай");
      expect(content).toContain("Лучше один-два проверенных, чем три наугад");
    }
  });

  /**
   * RU d03 and EN D3 on 24.09: two options where the anchor wants three,
   * «пешком» for a 20-minute walk guessed from the map, and a booking run
   * nobody asked for.
   */
  it("aims for three checked options, measures the walk and credits the map", async () => {
    const content = await resolveContent("photon-imessage");

    expect(content).toContain(
      "Цель — три варианта, у которых каждое условие подтверждено источником"
    );
    // RU 25.09, d03: one place after one round of searches.
    expect(content).toContain(
      "Ответ с одним-двумя — только если ещё один поиск новых кандидатов рядом ничего не дал; тогда скажи, сколько и почему"
    );
    expect(content).toContain(
      "Его `pick` считает, сколько кандидатов в пешей доступности и скольких не хватает до трёх"
    );
    expect(content).toContain("повтори с адресом без названия");
    // A map service that refuses is no reason to drop a candidate.
    expect(content).toContain(
      "остаётся кандидатом с пометкой «время пешком не проверил»: замену ему не ищи"
    );
    expect(content).toContain("почему выбрал его, и один честный минус");
    expect(content).toContain('`route_time` (`mode: "walking"`)');
    expect(content).toContain("«Пешком» — до 15 минут");
    expect(content).toContain("вариант дальше в три не входит");
    expect(content).toContain("минуты не выдумывай");
    // «Джаганнат» passed as «не сетевое» in two runs out of three.
    expect(content).toContain("два адреса под одним названием — это сеть");
    expect(content).toContain(
      "та страница, которую вернул инструмент, как есть"
    );
    expect(content).toContain("по данным © OpenStreetMap");
  });

  /**
   * RU 25.09: in d03 a headline over an option nobody checked, a walk nobody
   * measured, hours for one place of three, restoran.cafe's «мы не
   * бронируем» taken for the cafe's, and a chain kept as the third; in d13
   * the saved «свинину не ем» never applied; in d15 only «ещё ищу» while a
   * run searched.
   */
  it("keeps each option's facts its own, applies saved preferences and answers while a run searches", async () => {
    const content = await resolveContent("photon-imessage");

    expect(content).toContain(
      "Факт варианта — только из результата про этот вариант"
    );
    expect(content).toContain(
      "у каждого варианта — минуты его строки, кого не измерил, тому минут не пиши"
    );
    expect(content).toContain("Результат с `uncertain` фактом не выдавай");
    expect(content).toContain("Часы — на день и час просьбы");
    expect(content).toContain(
      "Фраза обо всех сразу («все с вегетарианским меню и чеком до 2500») — только если это подтверждено у каждого"
    );
    expect(content).toContain(
      "«Мы не бронируем» на агрегаторе (restoran.cafe и т. п.) — про сам агрегатор, а не про место"
    );
    expect(content).toContain(
      "ищи вместо него дальше, а не ставь третьим с оговоркой"
    );
    expect(content).toContain(
      "отсей по ним и назови в ответе, что учёл («учёл: без свинины»)"
    );
    expect(content).toContain("пометив «пока не проверено»");
    expect(content).toContain("на «ну что там?» хватит короткого статуса");
  });

  /**
   * One question, then one card: «Проверить стол?» and then «бронируй?»
   * would be two questions before the card, against the one-question rule.
   */
  it("ends with one booking question and books through one card", async () => {
    const content = await resolveContent("photon-imessage");

    expect(content).toContain(
      "Подбирай через `web_search`, `web_fetch` и `route_time`, без браузера"
    );
    // RU 25.09, d13: «поезд до казани и где поужинать» went to web_search
    // for the train too.
    expect(content).toContain(
      "билеты, места в поезде и номера на даты, даже в одной просьбе с ужином, ищет `browser_task` без `allowSubmit`"
    );
    expect(content).toContain("Закончи одним вопросом");
    expect(content).toContain("Других вопросов в этом сообщении нет");
    expect(content).toContain(
      "`browser_task start` без `allowSubmit` дойдёт до последнего шага перед кнопкой, и тогда один вопрос"
    );
    expect(content).toContain(
      "дойдёт до последнего шага перед кнопкой, и тогда один вопрос с вариантом, суммой и временем"
    );
    expect(content).toContain("До его «да» браузер не запускай");
    expect(content).not.toContain("Проверить свободный стол");
  });

  it("sends map lookups through site search instead of fetching the map", async () => {
    const content = await resolveContent("photon-imessage");

    expect(content).toContain('`sites: ["yandex.ru/maps"]`');
    expect(content).toContain('`sites: ["2gis.ru"]`');
  });

  it("leaves reports and Bro's own mail checks alone", async () => {
    expect(await resolveContent("scheduled-result")).toBeUndefined();
    expect(
      await resolveContent("scheduled-worker", {
        scheduledRunKind: "proactive",
      })
    ).toBeUndefined();
  });
});

async function resolveContent(
  authenticator: string,
  initiatorAttributes?: Record<string, string>
) {
  const resolve = recommendations.events["turn.started"];
  if (!resolve)
    throw new Error("Recommendation instructions resolve per turn.");
  const selected = await resolve(
    {},
    dynamicContext(authenticator, initiatorAttributes)
  );
  return selected?.content;
}

function dynamicContext(
  authenticator: string,
  initiatorAttributes?: Record<string, string>
) {
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
        initiator:
          initiatorAttributes === undefined
            ? null
            : {
                attributes: initiatorAttributes,
                authenticator,
                principalId: "user-1",
                principalType: "user",
              },
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}
