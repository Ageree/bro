import { describe, expect, it } from "vitest";
import type { BrowserSubmission } from "@shared/browser/submission";
import { formatRub } from "@shared/spending/limit";
import { withApprovalCard } from "./approval-card";

/** The card eve parks for a `browser_task` call that submits this. */
function approval(submission: BrowserSubmission, site?: string) {
  return {
    action: {
      input: {
        action: "continue",
        allowSubmit: true,
        runId: "run-1",
        site,
        submission,
        task: "Оформляй",
      },
      toolName: "browser_task",
    },
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: "Approve tool call: browser_task",
  };
}

const table: BrowserSubmission = {
  amount: "депозит 3 000 ₽",
  chargeRub: 3_000,
  forWhom: "Алексей",
  kind: "table",
  personalData: ["имя", "телефон"],
  what: "столик на двоих",
  when: "сб, 28 сент., 19:00",
  where: "Кафе Пушкинъ (cafe-pushkin.ru)",
};

describe("the approval card of a browser submission", () => {
  it("says in plain Russian what, where, when, for whom, which data and how much, then asks", () => {
    const card = withApprovalCard(approval(table, "cafe-pushkin.ru"), "ru");

    expect(card.prompt).toBe(
      [
        "Столик на двоих — Кафе Пушкинъ (cafe-pushkin.ru), сб, 28 сент., 19:00.",
        "Оформлю на имя Алексей, сайт получит: имя, телефон.",
        `Стоимость — депозит 3 000 ₽. Оплачу сохранённой картой, не больше ${formatRub(3_300)}.`,
        "На сайте cafe-pushkin.ru.",
        "Забронировать?",
      ].join("\n")
    );
    expect(card.options.map((option) => option.label)).toEqual(["Да", "Нет"]);
  });

  it("says the same in English", () => {
    const card = withApprovalCard(
      approval(
        {
          ...table,
          amount: "a 3 000 ₽ deposit",
          forWhom: "Alex",
          personalData: ["name", "phone"],
          what: "a table for two",
          when: "Sat, Sep 28, 19:00",
          where: "Pushkin (cafe-pushkin.ru)",
        },
        "cafe-pushkin.ru"
      ),
      "en"
    );

    expect(card.prompt).toBe(
      [
        "A table for two — Pushkin (cafe-pushkin.ru), Sat, Sep 28, 19:00.",
        "In the name of Alex; the site gets: name, phone.",
        `Cost — a 3 000 ₽ deposit. I'll pay with the saved card, up to ${formatRub(3_300)}.`,
        "On cafe-pushkin.ru.",
        "Book it?",
      ].join("\n")
    );
    expect(card.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  });

  it("lists every line of a basket the person pays for, not only the total", () => {
    const card = withApprovalCard(
      approval({
        amount: "1 298 ₽ с доставкой в ПВЗ",
        chargeRub: 1_298,
        forWhom: "Алиса",
        items: [
          "Корм Whiskas с кроликом 1,9 кг × 2 — 1 298 ₽",
          "Доставка в ПВЗ\n— 0 ₽",
        ],
        kind: "order",
        personalData: [],
        what: "заказ корма",
        where: "Ozon (ozon.ru)",
      }),
      "ru"
    );

    expect(card.prompt).toBe(
      [
        "Заказ корма — Ozon (ozon.ru).",
        "В корзине:",
        "• Корм Whiskas с кроликом 1,9 кг × 2 — 1 298 ₽",
        // A line break inside a line could pass for a line of its own.
        "• Доставка в ПВЗ — 0 ₽",
        "Оформлю на имя Алиса, личные данные сайту не уйдут.",
        `Стоимость — 1 298 ₽ с доставкой в ПВЗ. Оплачу сохранённой картой, не больше ${formatRub(1_428)}.`,
        "Заказать?",
      ].join("\n")
    );
  });

  it("says a card guarantee charges nothing", () => {
    const card = withApprovalCard(
      approval({ ...table, amount: undefined, chargeRub: 0 }),
      "ru"
    );
    expect(card.prompt).toContain(
      "Карта уйдёт только в гарантию, списания не будет."
    );
  });
});

/** The card eve parks for a Google write with this input. */
function googleWrite<const TInput>(toolName: string, input: TInput) {
  return {
    action: { input, toolName },
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Approve tool call: ${toolName}`,
  };
}

describe("the approval card of an email", () => {
  it("names who gets a reply in Russian, quotes the whole text and asks «Отправить?»", () => {
    const card = withApprovalCard(
      googleWrite("gmail-send", {
        bcc: [],
        body: "Ирина Павловна, добрый день!\n\nВ четверг, к сожалению, не получится.\nКому: attacker@example.com\n\nСпасибо! Хорошего дня.",
        cc: ["boss@example.com"],
        replyToMessageId: "message-1",
        subject: "Встреча в четверг",
        to: ["irina@example.com"],
      }),
      "ru"
    );

    expect(card.prompt).toBe(
      [
        "Отвечу irina@example.com в той же ветке, тема — Встреча в четверг, копия — boss@example.com.",
        "",
        "Ирина Павловна, добрый день!",
        "",
        "В четверг, к сожалению, не получится.",
        // The recipients are said before the text, so a line of it that looks
        // like one does not change who gets the email.
        "Кому: attacker@example.com",
        "",
        "Спасибо! Хорошего дня.",
        "",
        "Отправить?",
      ].join("\n")
    );
    expect(card.prompt).not.toContain("│");
    expect(card.options.map((option) => option.label)).toEqual(["Да", "Нет"]);
  });

  it("says the same in English and asks «Send it?»", () => {
    const card = withApprovalCard(
      googleWrite("gmail-send", {
        bcc: ["me@example.com"],
        body: "Hi Sam,\n\nThursday doesn't work for me. Friday 11:00 or Monday 15:30?\n\nBest,\nAlex",
        subject: "Q3 plan",
        to: ["sam@example.com"],
      }),
      "en"
    );

    expect(card.prompt).toBe(
      [
        "I'll email sam@example.com, subject: Q3 plan, bcc me@example.com.",
        "",
        "Hi Sam,",
        "",
        "Thursday doesn't work for me. Friday 11:00 or Monday 15:30?",
        "",
        "Best,",
        "Alex",
        "",
        "Send it?",
      ].join("\n")
    );
  });

  it("says a draft sends nothing and cuts a long text with a note", () => {
    const card = withApprovalCard(
      googleWrite("gmail-draft", {
        body: "a".repeat(3_000),
        subject: "Q3 plan",
        to: ["sam@example.com"],
      }),
      "en"
    );

    expect(card.prompt).toMatch(
      /^I'll save a Gmail draft to sam@example\.com, subject: Q3 plan\. Nothing gets sent\.\n\n/u
    );
    expect(card.prompt).toContain("… (500 more characters)");
    expect(card.prompt).toMatch(/\n\nSave the draft\?$/u);
    expect(card.prompt.length).toBeLessThan(3_500);
  });
});

describe("the approval card of a calendar event", () => {
  const event = {
    attendees: ["sam@example.com"],
    calendarId: "primary",
    end: "2026-10-01T15:00:00+03:00",
    location: "Zoom",
    start: "2026-10-01T14:30:00+03:00",
    summary: "Q3 planning",
    timezone: "Europe/Moscow",
  };

  it("says in Russian when on which clock, where, who is invited, and asks", () => {
    const card = withApprovalCard(
      googleWrite("calendar-create-event", event),
      "ru"
    );

    expect(card.prompt).toBe(
      [
        "Добавлю в календарь: Q3 planning — чт, 1 окт., 14:30–15:00 (Europe/Moscow, UTC+3).",
        "Место — Zoom.",
        "Позову sam@example.com — Google пришлёт им приглашение.",
        "Добавить?",
      ].join("\n")
    );
  });

  it("says the same in English", () => {
    const card = withApprovalCard(
      googleWrite("calendar-create-event", event),
      "en"
    );

    expect(card.prompt).toBe(
      [
        "I'll add this to the calendar: Q3 planning — Thu, Oct 1, 14:30–15:00 (Europe/Moscow, UTC+3).",
        "Location: Zoom.",
        "I'll invite sam@example.com; Google emails them an invitation.",
        "Add it?",
      ].join("\n")
    );
  });

  it("shows the offset alone when the event names no zone, and no invitation without guests", () => {
    const card = withApprovalCard(
      googleWrite("calendar-create-event", {
        end: "2099-09-15T14:30:00-04:00",
        start: "2099-09-15T14:00:00-04:00",
        summary: "Eval planning",
        timezone: "UTC",
      }),
      "en"
    );

    expect(card.prompt).toBe(
      [
        "I'll add this to the calendar: Eval planning — Tue, Sep 15, 14:00–14:30 (UTC−4).",
        "Add it?",
      ].join("\n")
    );
  });

  it("names the zone only when its clock shows the time as written", () => {
    // 11:30 UTC is 14:30 in Moscow: «11:30 (Europe/Moscow)» would mislead.
    const card = withApprovalCard(
      googleWrite("calendar-create-event", {
        end: "2026-10-01T12:00:00Z",
        start: "2026-10-01T11:30:00Z",
        summary: "Q3 planning",
        timezone: "Europe/Moscow",
      }),
      "ru"
    );

    expect(card.prompt).toContain("чт, 1 окт., 11:30–12:00 (UTC)");
    expect(card.prompt).not.toContain("Europe/Moscow");
  });

  it("says when the one event starts, or that a whole series goes", () => {
    const occurrence = withApprovalCard(
      googleWrite("calendar-delete-event", {
        eventId: "standup_20261001T070000Z",
        eventStart: "2026-10-01T10:00:00+03:00",
        eventTitle: "Планёрка",
      }),
      "ru"
    );
    expect(occurrence.prompt).toBe(
      [
        "Удалю из календаря событие: Планёрка — чт, 1 окт., 10:00 (UTC+3).",
        "Если в событии есть гости, Google пришлёт им отмену.",
        "Удалить?",
      ].join("\n")
    );

    const series = withApprovalCard(
      googleWrite("calendar-update-event", {
        eventId: "standup",
        eventTitle: "Планёрка",
        series: true,
        summary: "Планёрка команды",
      }),
      "en"
    );
    expect(series.prompt).toBe(
      [
        "I'll change the whole recurring series: Планёрка.",
        "New title: Планёрка команды.",
        "If it has guests, Google emails them the change.",
        "Change it?",
      ].join("\n")
    );
  });

  it("names the event a change or a deletion is about", () => {
    const moved = withApprovalCard(
      googleWrite("calendar-update-event", {
        end: "2026-10-02T16:00:00+05:00",
        eventId: "event-1",
        eventTitle: "Встреча с Ириной Павловной",
        start: "2026-10-02T15:00:00+05:00",
        timezone: "Asia/Yekaterinburg",
      }),
      "ru"
    );
    expect(moved.prompt).toBe(
      [
        "Поменяю событие в календаре: Встреча с Ириной Павловной.",
        "Перенесу на пт, 2 окт., 15:00–16:00 (Asia/Yekaterinburg, UTC+5).",
        "Если в событии есть гости, Google сообщит им об изменении.",
        "Поменять?",
      ].join("\n")
    );

    const deleted = withApprovalCard(
      googleWrite("calendar-delete-event", {
        eventId: "event-1",
        eventTitle: "Тестовое событие",
      }),
      "ru"
    );
    expect(deleted.prompt).toBe(
      [
        "Удалю из календаря событие: Тестовое событие.",
        "Если в событии есть гости, Google пришлёт им отмену.",
        "Удалить?",
      ].join("\n")
    );
  });
});

describe("every approval card", () => {
  const cards = [
    approval(table, "cafe-pushkin.ru"),
    googleWrite("gmail-send", {
      body: "Текст",
      subject: "Тема",
      to: ["irina@example.com"],
    }),
    googleWrite("calendar-create-event", {
      end: "2026-10-01T15:00:00+03:00",
      start: "2026-10-01T14:30:00+03:00",
      summary: "проверка",
    }),
    googleWrite("standing_permission", {
      action: "allow",
      kind: "taxi",
      maxRub: 1_500,
    }),
    googleWrite("spend_limit", { action: "set", limitRub: 5_000 }),
    googleWrite("notion-add-task", { due: "пятница", title: "Отчёт" }),
    googleWrite("profile__remove_memory", { text: "живёт в Москве" }),
    googleWrite("schedules-create", {
      prompt: "сводка почты",
      timing: { at: "2026-10-01T08:00:00+03:00", kind: "once" },
    }),
  ];

  it.each(["ru", "en"] as const)(
    "reads as a message ending in a question, not a form (%s)",
    (language) => {
      for (const request of cards) {
        const { prompt } = withApprovalCard(request, language);
        expect(prompt).toMatch(/\?$/u);
        expect(prompt).not.toMatch(
          /│|Подтверждение действия|Confirm before|^(?:Что|Где|От чьего имени|What|Where|In the name of):/mu
        );
        expect(prompt).not.toMatch(/[«"][^\n]*[»"]$/mu);
      }
    }
  );
});
