import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readWorkLines } from "@db/services/work-log";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn<() => boolean>(),
  lastLine: vi.fn<() => Promise<Date | undefined>>(),
  readWorkLines: vi.fn<typeof readWorkLines>(),
}));

vi.mock("@agent/lib/work-log/pilot", () => ({
  workLogEnabled: mocks.enabled,
}));

vi.mock("@db/services/work-log", () => ({
  lastWorkLineOfSession: mocks.lastLine,
  readWorkLines: mocks.readWorkLines,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: async () => await Promise.resolve("Europe/Moscow"),
}));

const { workLogBriefLines, workLogVoiceContext } =
  await import("@agent/lib/work-log/recall");

const scope = { userId: "u1", workspaceId: "w1" };
const now = new Date("2026-10-28T12:00:00Z");

function line(
  role: "bro" | "person",
  text: string,
  minute: number,
  options: {
    readonly files?: string[];
    readonly sessionId?: string;
    readonly turnId?: string;
  } = {}
) {
  return {
    createdAt: new Date(Date.UTC(2026, 9, 28, 11, minute)),
    files: options.files ?? [],
    role,
    sessionId: options.sessionId ?? "docs",
    text,
    turnId: options.turnId ?? "turn_1",
  };
}

const analysis =
  "Разобрал договор 14/26-П. Ставка Подольск — Краснодар 92 000 ₽ за рейс, оплата 30 банковских дней. Штраф за опоздание — 0,1% за каждый час сверх шести.";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.readWorkLines.mockResolvedValue([
    line("person", "Разбери договор с Агроторгом", 0, {
      files: ["Договор_14-26-П.pdf"],
    }),
    line("bro", "Секунду, считаю по договору.", 1),
    line("bro", analysis, 2),
    line("person", "Какая погода?", 3, { turnId: "turn_2" }),
    // The report of work handed off before, in a turn of its own.
    line("bro", "Отели нашёл: три варианта до 9 000 ₽ за ночь.", 4, {
      turnId: "turn_3",
    }),
  ]);
});

describe("what Bro did, read back in a new chat", () => {
  it("gives each request with its files and the answer of its turn, without the heads-up", async () => {
    const [context] = await workLogVoiceContext(scope, {
      now,
      sessionId: "voice",
    });

    expect(context).toContain(
      `- ср 28.10 14:00: просьба «Разбери договор с Агроторгом» (файлы: Договор_14-26-П.pdf) → Бро: «${analysis}»`
    );
    expect(context).not.toContain("Секунду");
    // Review 28.10: not the answer to the question asked meanwhile.
    expect(context).toContain("- ср 28.10 14:03: просьба «Какая погода?»\n");
    expect(context).toContain(
      "- ср 28.10 14:04: Бро сообщил: «Отели нашёл: три варианта до 9 000 ₽ за ночь.»"
    );
    expect(mocks.readWorkLines).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ excludeSession: "voice" })
    );
  });

  it("leaves a sentence naming a door or a code out of what the voice says aloud", async () => {
    mocks.readWorkLines.mockResolvedValue([
      line("person", "Как попасть в офис?", 0),
      line(
        "bro",
        "Офис на Индустриальной, 9. Код домофона 4512. Охрана до 22:00 — это мой ответ целиком.",
        1
      ),
    ]);

    const [brief] = await workLogBriefLines(scope, {
      now,
      timeZone: "Europe/Moscow",
    });

    expect(brief).toContain("Офис на Индустриальной, 9.");
    expect(brief).toContain("Охрана до 22:00");
    expect(brief).not.toContain("домофон");
  });

  it("says in the voice's brief where an answer was cut, and gives Bro's turn the whole of it", async () => {
    const report = `Посчитал квартал. ${"Выручка росла каждый месяц. ".repeat(20)}Падают ИП Смирнов и ФармЛайн.`;
    mocks.readWorkLines.mockResolvedValue([
      line("person", "Посчитай квартал", 0),
      line("bro", report, 1),
    ]);

    const [brief] = await workLogBriefLines(scope, {
      now,
      timeZone: "Europe/Moscow",
    });
    const [context] = await workLogVoiceContext(scope, { now });

    expect(brief).toMatch(/… \[дальше обрезано — остальное знает Бро\]»$/u);
    expect(brief).not.toContain("Смирнов");
    expect(context).toContain("Падают ИП Смирнов и ФармЛайн.»");
  });

  it("keeps the newest requests that fit", async () => {
    mocks.readWorkLines.mockResolvedValue(
      Array.from({ length: 60 }, (_, index) =>
        line(
          "person",
          `Просьба ${String(index)} ${"слово ".repeat(40)}`,
          index,
          {
            sessionId: `s${String(index)}`,
          }
        )
      )
    );

    const lines = await workLogBriefLines(scope, {
      now,
      timeZone: "Europe/Moscow",
    });

    expect(lines.length).toBeLessThan(60);
    expect(lines.at(-1)).toContain("Просьба 59");
  });

  it("gives a later turn of the chat only what came since its last line", async () => {
    mocks.lastLine.mockResolvedValue(new Date(Date.UTC(2026, 9, 28, 11, 5)));

    await workLogVoiceContext(scope, { now, sessionId: "voice" });

    expect(mocks.readWorkLines).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({
        since: new Date(Date.UTC(2026, 9, 28, 11, 5)),
      })
    );
  });

  it("reads nothing outside the pilot", async () => {
    mocks.enabled.mockReturnValue(false);

    expect(await workLogVoiceContext(scope, { now })).toEqual([]);
    expect(mocks.readWorkLines).not.toHaveBeenCalled();
  });
});
