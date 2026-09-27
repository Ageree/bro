import { describe, expect, it } from "vitest";
import {
  calendarSignals,
  flightReminders,
  gmailProbeQuery,
  gmailSignals,
  isNightFlight,
  isNightSubject,
  mailRank,
  mailSearchStart,
  proactiveRunPrompt,
  reminderOf,
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

  it("keeps what matters over newsletters when a backlog does not fit, newest first within a rank", () => {
    const mail = gmailSignals(
      ["n1", "n2", "friend", "n3", "parcel", "n4", "boss"].map((id) => ({
        id,
      }))
    );
    const ranks = new Map([
      ["n1", 3],
      ["n2", 3],
      ["n3", 3],
      ["n4", 3],
      ["parcel", 0],
      ["boss", 1],
      ["friend", 1],
    ]);
    const selected = selectRunSignals(mail, ranks).map(({ itemId }) => itemId);
    expect(selected).toEqual([
      "parcel",
      "friend",
      "boss",
      "n1",
      "n2",
      "n3",
      "n4",
    ]);
    // Mail that was not ranked stands after known senders, before bulk.
    expect(
      selectRunSignals(
        mail,
        new Map([
          ["n1", 3],
          ["boss", 1],
        ])
      ).map(({ itemId }) => itemId)
    ).toEqual(["boss", "n2", "friend", "n3", "parcel", "n4", "n1"]);
  });

  it("names only the new threads and events and the calendar window", () => {
    const prompt = proactiveRunPrompt({
      home: noHome,
      scheduledFor: now,
      signals: [
        { dedupeKey: "m1", itemId: "m1", source: "gmail", threadId: "t1" },
        { dedupeKey: "m2", itemId: "m2", source: "gmail", threadId: "t1" },
        {
          dedupeKey: "flight@2026-09-24T07:40:00Z",
          itemId: "flight",
          source: "calendar",
          threadId: null,
        },
      ],
    });
    expect(prompt).toContain("gmail-read-thread): t1\n");
    expect(prompt).toContain(
      "timeMin 2026-09-23T12:00:00.000Z and timeMax 2026-09-24T14:00:00.000Z"
    );
    expect(prompt).toContain("these ids): flight");
    expect(prompt).not.toContain("quiet hours");
    expect(prompt).not.toContain("Flight reminders");
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

  it("tells the worker a reminder is due for a flight it may have seen, and what to say", () => {
    const prompt = proactiveRunPrompt({
      home: noHome,
      scheduledFor: now,
      signals: [
        {
          dedupeKey: "flight@2026-09-24T07:05:00+03:00#checkin",
          itemId: "flight",
          source: "calendar",
          threadId: null,
        },
        {
          dedupeKey: "flight@2026-09-24T07:05:00+03:00#evening",
          itemId: "flight",
          source: "calendar",
          threadId: null,
        },
      ],
    });
    expect(prompt).toContain(
      "No new calendar events. For the flights below, call calendar-list-events once with timeMin 2026-09-23T12:00:00.000Z"
    );
    expect(prompt).toContain("Earlier checks may have seen these flights");
    expect(prompt).toContain("- flight: online check-in is open now");
    expect(prompt).toContain("Also, it leaves tomorrow morning");
    expect(prompt).toContain(
      "Make [срочно] the first line of your handover: it has to reach the person tonight"
    );
    // One line per flight, however many reminders it has.
    expect(prompt.match(/^- flight:/gmu)).toHaveLength(1);
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

/** A moment on the Moscow clock, `YYYY-MM-DDTHH:mm:ss`. */
function at(time: string) {
  return new Date(`${time}+03:00`);
}

describe("flight reminders by the clock", () => {
  const moscow = "Europe/Moscow";
  // DP 405 tomorrow at 07:05 in Moscow, the checks saw it days ago.
  const flight = {
    id: "dp405",
    location: "Аэропорт Внуково (VKO), терминал A",
    start: { dateTime: "2026-09-24T07:05:00+03:00" },
    status: "confirmed",
    summary: "Рейс DP 405 Москва (Внуково) — Сочи",
  };
  const due = (clock: Date, night = false, events = [flight]) =>
    flightReminders(events, clock, moscow, { night }).map(
      ({ dedupeKey }) => dedupeKey
    );

  it("reminds the evening before an early flight, before the night", () => {
    expect(due(at("2026-09-23T17:59:00"))).not.toContain(
      "dp405@2026-09-24T07:05:00+03:00#evening"
    );
    expect(due(at("2026-09-23T18:00:00"))).toContain(
      "dp405@2026-09-24T07:05:00+03:00#evening"
    );
    expect(due(at("2026-09-23T21:45:00"))).toContain(
      "dp405@2026-09-24T07:05:00+03:00#evening"
    );
  });

  it("still reminds a night check until 23:00, and never after", () => {
    expect(due(at("2026-09-23T22:27:00"), true)).toEqual([
      "dp405@2026-09-24T07:05:00+03:00#evening",
    ]);
    expect(due(at("2026-09-23T23:00:00"), true)).toEqual([]);
    expect(due(at("2026-09-24T03:00:00"), true)).toEqual([]);
  });

  it("reminds at check-in opening, by day only, and not once the person is on the way", () => {
    const opens = "dp405@2026-09-24T07:05:00+03:00#checkin";
    // 24 hours before departure is 07:05 the day before: still night for Bro.
    expect(due(at("2026-09-23T07:05:00"), true)).not.toContain(opens);
    expect(due(at("2026-09-23T07:00:00"))).not.toContain(opens);
    expect(due(at("2026-09-23T08:00:00"))).toEqual([opens]);
    expect(due(at("2026-09-23T12:20:00"))).toEqual([opens]);
    expect(due(at("2026-09-24T04:30:00"))).not.toContain(opens);
  });

  it("keys each reminder apart from the event, so seeing the flight does not silence it", () => {
    const [checkin, evening] = flightReminders(
      [flight],
      at("2026-09-23T19:00:00"),
      moscow,
      { night: false }
    );
    expect(checkin).toEqual({
      dedupeKey: "dp405@2026-09-24T07:05:00+03:00#checkin",
      itemId: "dp405",
      source: "calendar",
      threadId: null,
    });
    expect(evening?.dedupeKey).toBe("dp405@2026-09-24T07:05:00+03:00#evening");
    const [seen] = calendarSignals([flight], at("2026-09-23T12:00:00"), moscow);
    expect(seen?.dedupeKey).not.toBe(checkin?.dedupeKey);
    expect(reminderOf(checkin?.dedupeKey ?? "")).toBe("checkin");
    expect(reminderOf(evening?.dedupeKey ?? "")).toBe("evening");
    expect(reminderOf(seen?.dedupeKey ?? "")).toBeUndefined();
  });

  it("leaves an afternoon flight, a meeting, a cancelled flight and a far one to the other checks", () => {
    const evening = at("2026-09-23T19:00:00");
    expect(
      due(evening, false, [
        {
          ...flight,
          id: "afternoon",
          start: { dateTime: "2026-09-24T15:30:00+03:00" },
        },
      ])
    ).toEqual(["afternoon@2026-09-24T15:30:00+03:00#checkin"]);
    expect(
      due(evening, false, [
        {
          id: "standup",
          location: "Офис",
          start: { dateTime: "2026-09-24T09:00:00+03:00" },
          status: "confirmed",
          summary: "Планёрка",
        },
        { ...flight, id: "cancelled", status: "cancelled" },
        {
          ...flight,
          id: "far",
          start: { dateTime: "2026-09-26T07:05:00+03:00" },
        },
      ])
    ).toEqual([]);
  });
});

describe("what matters in a backlog of mail", () => {
  const letter = {
    bulk: false,
    from: "",
    labels: ["INBOX", "UNREAD"],
    subject: "",
  };

  it("puts flights, security, phishing by its sender and parcels first", () => {
    for (const mail of [
      { ...letter, subject: "Изменение выхода на посадку: рейс SU 1234" },
      { ...letter, subject: "Новый вход в аккаунт Google", bulk: true },
      {
        ...letter,
        from: "Служба безопасности банка <security@bank-notice.example.com>",
        subject: "Подтвердите операцию по карте",
      },
      {
        ...letter,
        bulk: true,
        from: "СДЭК <noreply@cdek.example.com>",
        labels: ["INBOX", "CATEGORY_UPDATES"],
        subject: "Заказ 1234567890: изменился срок доставки",
      },
    ]) {
      expect(mailRank(mail)).toBe(0);
    }
  });

  it("puts known people before strangers, and newsletters last", () => {
    expect(
      mailRank({
        ...letter,
        from: "Андрей Волков <andrey@example.org>",
        labels: ["INBOX", "IMPORTANT", "CATEGORY_PERSONAL"],
        subject: "Q3",
      })
    ).toBe(1);
    expect(
      mailRank({ ...letter, from: "someone@example.net", subject: "Вопрос" })
    ).toBe(2);
    expect(
      mailRank({
        ...letter,
        bulk: true,
        from: "Дайджест <news@example.com>",
        labels: ["INBOX", "CATEGORY_UPDATES", "IMPORTANT"],
        subject: "Лучшее за неделю",
      })
    ).toBe(3);
  });

  it("does not put a promotion about flights or delivery first", () => {
    const promotion = {
      ...letter,
      bulk: true,
      labels: ["INBOX", "CATEGORY_UPDATES"],
    };
    expect(
      mailRank({
        ...promotion,
        from: "Магазин <news@shop.example.com>",
        subject: "Бесплатная доставка до конца недели",
      })
    ).toBe(1);
    expect(
      mailRank({
        ...promotion,
        from: "Авиакомпания <news@airline.example.com>",
        subject: "Рейсы в Сочи от 2990 ₽",
      })
    ).toBe(1);
  });
});
