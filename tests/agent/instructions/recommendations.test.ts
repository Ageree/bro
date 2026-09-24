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
