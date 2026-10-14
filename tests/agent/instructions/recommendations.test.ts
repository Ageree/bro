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
    }
  });

  /**
   * One question, then one card: «Проверить стол?» and then «бронируй?»
   * would be two questions before the card, against the one-question rule.
   */
  it("ends with one booking question and then books at once", async () => {
    const content = await resolveContent("photon-imessage");

    expect(content).toContain(
      "Подбирай через `web_search`, `web_fetch` и `route_time`, без браузера"
    );
    // RU 25.09, d13: «поезд до казани и где поужинать» went to web_search
    // for the train too.
    expect(content).toContain(
      "билеты, места в поезде и номера на даты, даже в одной просьбе с ужином, ищет `browser_task` без `allowSubmit`"
    );
    expect(content).toContain(
      '`browser_task start` с `personWants: "done"` без `allowSubmit` найдёт слот и остановится'
    );
    expect(content).toContain(
      "бесплатная бронь уходит сразу, второго вопроса нет"
    );
    expect(content).toContain("До его «да» браузер не запускай");
    expect(content).not.toContain("Проверить свободный стол");
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
