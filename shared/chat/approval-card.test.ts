import { describe, expect, it } from "vitest";
import type { BrowserSubmission } from "@shared/browser/submission";
import { formatRub } from "@shared/spending/limit";
import { withApprovalCard } from "./approval-card";

/** The card eve parks for a `browser_task` call that submits this. */
function approval(submission: BrowserSubmission) {
  return {
    action: {
      input: {
        action: "continue",
        allowSubmit: true,
        runId: "run-1",
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

describe("the approval card of a basket", () => {
  it("lists every line the person pays for, not only the total", () => {
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
        "Подтверждение действия:",
        "Что: заказ корма",
        "Состав:",
        "• Корм Whiskas с кроликом 1,9 кг × 2 — 1 298 ₽",
        // A line break inside a line could pass for a field of its own.
        "• Доставка в ПВЗ — 0 ₽",
        "Где: Ozon (ozon.ru)",
        "От чьего имени: Алиса",
        "Стоимость: 1 298 ₽ с доставкой в ПВЗ",
        "Какие данные уйдут: —",
        `Оплата сохранённой картой, не больше ${formatRub(1_428)}`,
      ].join("\n")
    );
  });

  it("draws no list for a submission that is not a basket", () => {
    const card = withApprovalCard(
      approval({
        forWhom: "Alice",
        kind: "table",
        personalData: ["name"],
        what: "a table for two",
        when: "today, 20:00",
        where: "Pushkin (cafe-pushkin.ru)",
      }),
      "en"
    );

    expect(card.prompt).not.toContain("Items");
    expect(card.prompt).toContain("What: a table for two");
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
  it("shows the recipients, the thread and the text of a reply", () => {
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
        "Отправить письмо:",
        "Кому: irina@example.com",
        "Копия: boss@example.com",
        "Ответ в ветке: «Встреча в четверг»",
        "Текст:",
        "│ Ирина Павловна, добрый день!",
        "│",
        "│ В четверг, к сожалению, не получится.",
        // A line of the text never passes for a field of the card.
        "│ Кому: attacker@example.com",
        "│",
        "│ Спасибо! Хорошего дня.",
      ].join("\n")
    );
    expect(card.options.map((option) => option.label)).toEqual([
      "Подтвердить",
      "Отмена",
    ]);
  });

  it("names a new email by its subject and cuts a long text with a note", () => {
    const card = withApprovalCard(
      googleWrite("gmail-draft", {
        body: "a".repeat(3_000),
        subject: "Q3 plan",
        to: ["sam@example.com"],
      }),
      "en"
    );

    expect(card.prompt).toContain("Save a draft in Gmail (nothing is sent):");
    expect(card.prompt).toContain("Subject: Q3 plan");
    expect(card.prompt).toContain("… (500 more characters)");
    expect(card.prompt.length).toBeLessThan(3_500);
  });
});

describe("the approval card of a calendar event", () => {
  it("says when on which clock, who is invited and that they get an invitation", () => {
    const card = withApprovalCard(
      googleWrite("calendar-create-event", {
        attendees: ["sam@example.com"],
        calendarId: "primary",
        end: "2026-10-01T15:00:00+03:00",
        location: "Zoom",
        start: "2026-10-01T14:30:00+03:00",
        summary: "Q3 planning",
        timezone: "Europe/Moscow",
      }),
      "ru"
    );

    expect(card.prompt).toBe(
      [
        "Создать событие в календаре:",
        "«Q3 planning»",
        "Когда: чт, 1 окт., 14:30–15:00 (Europe/Moscow, UTC+3)",
        "Где: Zoom",
        "Гости: sam@example.com",
        "Гостям уйдёт приглашение от Google.",
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

    expect(card.prompt).toContain("When: Tue, Sep 15, 14:00–14:30 (UTC−4)");
    expect(card.prompt).not.toContain("invitation");
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

    expect(card.prompt).toContain("Когда: чт, 1 окт., 11:30–12:00 (UTC)");
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
        "Удалить событие из календаря «Планёрка» (чт, 1 окт., 10:00 (UTC+3)).",
        "Если в событии есть гости, Google пришлёт им отмену.",
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
    expect(series.prompt).toContain(
      "Change the whole recurring series «Планёрка»:"
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
        "Изменить событие в календаре «Встреча с Ириной Павловной»:",
        "Новое время: пт, 2 окт., 15:00–16:00 (Asia/Yekaterinburg, UTC+5)",
        "Если в событии есть гости, Google сообщит им об изменении.",
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
        "Удалить событие из календаря «Тестовое событие».",
        "Если в событии есть гости, Google пришлёт им отмену.",
      ].join("\n")
    );
  });
});
