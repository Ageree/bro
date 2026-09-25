import { describe, expect, it } from "vitest";
import {
  calendarSignals,
  gmailProbeQuery,
  gmailSignals,
  isNightFlight,
  isNightSubject,
  mailSearchStart,
  proactiveRunPrompt,
  selectRunSignals,
} from "@agent/lib/proactive/signals";
import { emptyUserProfile } from "@shared/user-profile/schema";

const now = new Date("2026-09-23T12:00:00.000Z");
const noHome = emptyUserProfile;

describe("proactive signals", () => {
  it("overlaps the mail watermark but never looks back more than a day", () => {
    expect(mailSearchStart(new Date("2026-09-23T11:45:00.000Z"), now)).toEqual(
      new Date("2026-09-23T11:35:00.000Z")
    );
    expect(mailSearchStart(new Date("2026-09-10T00:00:00.000Z"), now)).toEqual(
      new Date("2026-09-22T12:00:00.000Z")
    );
  });

  it("searches only new inbox mail that is not promotional, a mailing list or the person's own", () => {
    expect(gmailProbeQuery(new Date("2026-09-23T11:35:00.000Z"))).toBe(
      "in:inbox after:1790163300 -category:promotions -category:social -category:forums -from:me"
    );
  });

  it("keys mail by message id and keeps its thread for the worker", () => {
    expect(
      gmailSignals([
        { id: "m1", threadId: "t1" },
        { id: null, threadId: "t2" },
        { id: "m3" },
      ])
    ).toEqual([
      { dedupeKey: "m1", itemId: "m1", source: "gmail", threadId: "t1" },
      { dedupeKey: "m3", itemId: "m3", source: "gmail", threadId: "m3" },
    ]);
  });

  it("keys events by id and start, and drops cancelled or started ones", () => {
    expect(
      calendarSignals(
        [
          {
            id: "flight",
            start: { dateTime: "2026-09-24T07:40:00+03:00" },
            status: "confirmed",
          },
          {
            id: "cancelled",
            start: { dateTime: "2026-09-24T09:00:00Z" },
            status: "cancelled",
          },
          { id: "ongoing", start: { dateTime: "2026-09-23T11:00:00Z" } },
          { id: "trip", start: { date: "2026-09-21" } },
          { id: "today", start: { date: "2026-09-23" } },
          { id: "holiday", start: { date: "2026-09-24" } },
          { id: null, start: { dateTime: "2026-09-24T10:00:00Z" } },
        ],
        now,
        "Europe/Moscow"
      )
    ).toEqual([
      {
        dedupeKey: "flight@2026-09-24T07:40:00+03:00",
        itemId: "flight",
        source: "calendar",
        threadId: null,
      },
      {
        dedupeKey: "holiday@2026-09-24",
        itemId: "holiday",
        source: "calendar",
        threadId: null,
      },
    ]);
  });

  it("dates an all-day event on the person's own calendar", () => {
    // Already 24 September in Moscow, still the 23rd in Los Angeles.
    const lateEvening = new Date("2026-09-23T22:30:00.000Z");
    const birthday = [{ id: "birthday", start: { date: "2026-09-24" } }];
    expect(calendarSignals(birthday, lateEvening, "Europe/Moscow")).toEqual([]);
    expect(
      calendarSignals(birthday, lateEvening, "America/Los_Angeles")
    ).toHaveLength(1);
  });

  it("treats a moved event as a new signal", () => {
    const [before] = calendarSignals(
      [{ id: "flight", start: { dateTime: "2026-09-24T07:40:00Z" } }],
      now,
      "Europe/Moscow"
    );
    const [after] = calendarSignals(
      [{ id: "flight", start: { dateTime: "2026-09-24T09:10:00Z" } }],
      now,
      "Europe/Moscow"
    );
    expect(before?.dedupeKey).not.toBe(after?.dedupeKey);
  });

  it("puts events first and caps one run at twelve items", () => {
    const mail = gmailSignals(
      Array.from({ length: 20 }, (_, index) => ({ id: `m${String(index)}` }))
    );
    const events = calendarSignals(
      [{ id: "flight", start: { dateTime: "2026-09-24T07:40:00Z" } }],
      now,
      "Europe/Moscow"
    );
    const selected = selectRunSignals([...mail, ...events]);
    expect(selected).toHaveLength(12);
    expect(selected[0]?.itemId).toBe("flight");
    expect(selected[1]?.itemId).toBe("m0");
  });

  it("names only the new threads and events and the calendar window", () => {
    const prompt = proactiveRunPrompt({
      home: noHome,
      scheduledFor: now,
      signals: [
        { itemId: "m1", source: "gmail", threadId: "t1" },
        { itemId: "m2", source: "gmail", threadId: "t1" },
        { itemId: "flight", source: "calendar", threadId: null },
      ],
    });
    expect(prompt).toContain("gmail-read-thread): t1\n");
    expect(prompt).toContain(
      "timeMin 2026-09-23T12:00:00.000Z and timeMax 2026-09-24T14:00:00.000Z"
    );
    expect(prompt).toContain("these ids): flight");
    expect(prompt).not.toContain("quiet hours");
    expect(
      proactiveRunPrompt({ home: noHome, scheduledFor: now, signals: [] })
    ).toContain("No new mail.");
  });

  it("tells the worker where home is, for the time to leave for a flight", () => {
    expect(
      proactiveRunPrompt({
        home: {
          ...noHome,
          addressLine1: "ул. Профсоюзная, 12",
          city: "Москва",
        },
        scheduledFor: now,
        signals: [],
      })
    ).toContain(
      "Home (Personal Info; count a leave-by time from here): ул. Профсоюзная, 12, Москва"
    );
    expect(
      proactiveRunPrompt({ home: noHome, scheduledFor: now, signals: [] })
    ).toContain("count a leave-by time from the city centre and say so");
  });

  it("warns a night run that its handover waits unless marked urgent", () => {
    const prompt = proactiveRunPrompt({
      home: noHome,
      quietUntil: "2026-09-24 08:00, Thursday (Europe/Moscow)",
      scheduledFor: now,
      signals: [],
    });
    expect(prompt).toContain(
      "quiet hours until 2026-09-24 08:00, Thursday (Europe/Moscow)"
    );
    expect(prompt).toContain("unless its first line is [срочно]");
  });
});

describe("what may wake the person at night", () => {
  const evening = new Date("2026-09-23T20:00:00.000Z");

  it("takes a flight leaving within hours, not a morning meeting or a far flight", () => {
    expect(
      isNightFlight(
        {
          location: "Vnukovo International Airport",
          start: { dateTime: "2026-09-24T04:05:00Z" },
          summary: "Москва — Сочи",
        },
        evening
      )
    ).toBe(true);
    expect(
      isNightFlight(
        {
          start: { dateTime: "2026-09-24T04:05:00Z" },
          summary: "Рейс DP 405",
        },
        evening
      )
    ).toBe(true);
    expect(
      isNightFlight(
        {
          start: { dateTime: "2026-09-24T06:00:00Z" },
          summary: "Созвон с командой",
        },
        evening
      )
    ).toBe(false);
    expect(
      isNightFlight(
        {
          start: { dateTime: "2026-09-26T04:05:00Z" },
          summary: "Flight to Sochi (SU 1234)",
        },
        evening
      )
    ).toBe(false);
    // An all-day trip has no departure to leave for.
    expect(
      isNightFlight({ start: {}, summary: "Перелёт в Сочи" }, evening)
    ).toBe(false);
  });

  it("reads a flight change or an account alert in a subject, not a friend or a parcel", () => {
    for (const subject of [
      "Изменение выхода на посадку: рейс SU 1234",
      "Your flight UA 1532 is delayed",
      "Новый вход в аккаунт Google",
      "Служба безопасности банка: подтвердите операцию",
    ]) {
      expect(isNightSubject(subject)).toBe(true);
    }
    for (const subject of [
      "го в субботу на шашлыки?",
      "СДЭК: посылка задерживается",
      "Можешь к утру глянуть цифры по Q3?",
    ]) {
      expect(isNightSubject(subject)).toBe(false);
    }
  });
});
