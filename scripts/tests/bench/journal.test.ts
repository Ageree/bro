import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import {
  CaseJournal,
  describeEvent,
  isoWithOffset,
  maskCodes,
  readRunRecord,
  runRecordSchema,
  type RunRecord,
} from "../../bench/journal.ts";
import { recordedEvents } from "./recorded.ts";

/** A minimal valid record whose prompt is `promptSent`. */
function recordFor(journal: CaseJournal, promptSent: string): RunRecord {
  return {
    caseId: "case",
    channel: "веб",
    cleanupDone: false,
    codesRequested: 0,
    driver: {
      backgroundRuns: [],
      decisions: [],
      fixtures: [],
      host: "http://127.0.0.1:9",
      observations: [],
      paced: false,
      pendingInputs: [],
      remainingSteps: [],
      riskLevel: null,
      scriptNotes: [],
      // An id that looks like a card number stays as it is.
      sessions: [{ sessionId: "wrun_4111111111111111", streamIndex: 3 }],
      status: "completed",
      statusDetail: null,
      suite: "ru",
      title: "Тест",
      turns: [],
    },
    evidence: [journal.paths.log, journal.paths.events],
    finishedAt: null,
    hints: 0,
    naReason: null,
    notes: "",
    outcome: null,
    product: "Бро",
    productVersion: null,
    promptSent,
    safetyViolations: [],
    score: null,
    startedAt: "2026-09-24T15:00:00+03:00",
    tester: "тест",
    timezone: "Europe/Moscow",
    transcript: journal.paths.log,
    vpnNeeded: false,
  };
}

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
    const cards = lines.filter((line) =>
      line.startsWith("?? КАРТОЧКА tool-approval calendar-create-event")
    );
    expect(cards).toHaveLength(2);
    // The card reads as the person sees it, not as eve titles it.
    for (const card of cards) {
      expect(card).toContain(
        "calendar-create-event: Создать событие в календаре:"
      );
      expect(card).toContain("approve «Подтвердить»");
      expect(card).not.toContain("Approve tool call");
    }
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

  it("masks personal data in the events, the log and the record", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bench-journal-"));
    const journal = new CaseJournal(outDir, "d07-doctor", "Europe/Moscow");
    await journal.open();
    const personal =
      "запиши меня: паспорт 4510 123456, СНИЛС 123-456-789 01, карта 4111 1111 1111 1111, Екатеринбург, ул. Малышева, д. 51, кв. 12";
    const received: MessageStreamEvent = {
      data: { message: personal, sequence: 0, turnId: "turn_0" },
      meta: { at: "2026-09-24T12:00:00.000Z", id: "evt_1" },
      type: "message.received",
    };

    await journal.event("wrun_test", received);
    await journal.save(recordFor(journal, personal));

    const written = await Promise.all(
      Object.values(journal.paths).map((path) => readFile(path, "utf8"))
    );
    for (const text of written) {
      expect(text).toContain("Екатеринбург");
      for (const secret of [
        "123456",
        "789 01",
        "4111 1111",
        "Малышева",
        // Not a bare "51": the log's clock can read 19:51.
        "д. 51",
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    const saved = await readRunRecord(outDir, "d07-doctor");
    expect(saved.driver.sessions).toEqual([
      { sessionId: "wrun_4111111111111111", streamIndex: 3 },
    ]);
  });

  it("moves a previous run's files aside instead of appending to them", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bench-journal-"));
    const first = new CaseJournal(outDir, "d13-memory", "Europe/Moscow");
    await first.open();
    await first.line("первый прогон");
    await first.save(recordFor(first, "первый"));

    const second = new CaseJournal(outDir, "d13-memory", "Europe/Moscow");
    await second.open();
    await second.line("второй прогон");

    const log = await readFile(second.paths.log, "utf8");
    expect(log).toContain("второй прогон");
    expect(log).not.toContain("первый прогон");
    const [archived] = await readdir(join(outDir, "previous"));
    if (!archived) throw new Error("the first run was not kept");
    const archive = join(outDir, "previous", archived);
    expect(await readdir(archive)).toEqual([
      "d13-memory.json",
      "d13-memory.log",
    ]);
    const record = runRecordSchema.parse(
      JSON.parse(await readFile(join(archive, "d13-memory.json"), "utf8"))
    );
    expect(record.transcript).toBe(join(archive, "d13-memory.log"));
    expect(await readFile(record.transcript, "utf8")).toContain(
      "первый прогон"
    );
  });

  it("refuses a record that breaks the published format", () => {
    expect(
      runRecordSchema.safeParse({ caseId: "d03-recommendations", score: 11 })
        .success
    ).toBe(false);
  });
});
