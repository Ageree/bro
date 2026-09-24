import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CaseJournal,
  describeEvent,
  isoWithOffset,
  maskCodes,
  runRecordSchema,
} from "../../bench/journal.ts";
import { recordedEvents } from "./recorded.ts";

describe("maskCodes", () => {
  it("masks a code the tester sent wherever it appears", () => {
    expect(
      maskCodes('{"text":"482913"} и снова 482913', new Set(["482913"]))
    ).toBe('{"text":"******"} и снова ******');
  });

  it("masks digits that follow a word for a code", () => {
    expect(maskCodes("Код из смс: 12 34 56, заказ на 2 500 ₽", new Set())).toBe(
      "Код из смс: ******, заказ на 2 500 ₽"
    );
    expect(maskCodes("your code is 7731", new Set())).toBe(
      "your code is ******"
    );
  });

  it("leaves prices and times alone", () => {
    const text = "поезд в 18:40, 5 900 ₽ за место у окна";
    expect(maskCodes(text, new Set())).toBe(text);
  });
});

describe("isoWithOffset", () => {
  it("writes the tester's local time with its offset", () => {
    const at = new Date("2026-09-23T14:05:00Z");
    expect(isoWithOffset(at, "Asia/Yekaterinburg")).toBe(
      "2026-09-23T19:05:00+05:00"
    );
    expect(isoWithOffset(at, "UTC")).toBe("2026-09-23T14:05:00+00:00");
  });
});

describe("describeEvent on recorded turns", () => {
  it("shows the incoming message and what Bro delivered", () => {
    const lines = recordedEvents("uc-mo-split").flatMap(
      (event) => describeEvent(event) ?? []
    );
    expect(lines).toContain(
      "-> входящее: скидывались на дачу: я заплатил 24к, саша 8к, дима 0, катя 12к. посчитай, кто кому сколько по сбп"
    );
    expect(lines.some((line) => line.startsWith("<- Бро: всего 44к"))).toBe(
      true
    );
    // `send_message` is shown as the delivered message, not as a raw call.
    expect(lines.some((line) => line.includes("вызов send_message"))).toBe(
      false
    );
  });

  it("shows the photo, the approval card and the failed tool", () => {
    const lines = recordedEvents("uc-ma-event-from-photo").flatMap(
      (event) => describeEvent(event) ?? []
    );
    expect(
      lines.some((line) => line.includes("[вложения: event-poster.png]"))
    ).toBe(true);
    expect(
      lines.filter((line) =>
        line.startsWith("?? КАРТОЧКА tool-approval calendar-create-event")
      )
    ).toHaveLength(2);
    expect(
      lines.some(
        (line) => line.startsWith("   карточка ") && line.endsWith(": approved")
      )
    ).toBe(true);
    expect(
      lines.some((line) => line.startsWith("   ! calendar-create-event failed"))
    ).toBe(true);
  });
});

describe("CaseJournal", () => {
  it("masks codes in every file it writes", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bench-journal-"));
    const journal = new CaseJournal(outDir, "d06-gosuslugi", "Europe/Moscow");
    await journal.open();
    journal.knownCodes.add("551177");
    const [started] = recordedEvents("uc-mo-split");
    if (!started) throw new Error("fixture is empty");

    await journal.line("== тестировщик (code, продолжение): 551177");
    await journal.event("wrun_test", started);

    const log = await readFile(journal.paths.log, "utf8");
    expect(log).toContain("== тестировщик (code, продолжение): ******");
    expect(log).not.toContain("551177");
    const events = await readFile(journal.paths.events, "utf8");
    expect(JSON.parse(events.trim())).toMatchObject({
      event: { type: "session.started" },
      sessionId: "wrun_test",
    });
  });

  it("refuses a record that breaks the published format", () => {
    expect(
      runRecordSchema.safeParse({ caseId: "d03-recommendations", score: 11 })
        .success
    ).toBe(false);
  });
});
