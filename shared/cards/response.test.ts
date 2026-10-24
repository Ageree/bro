import { describe, expect, it } from "vitest";
import hotelChoice from "../../docs/cards/examples/hotel-choice.json";
import hotelApp from "../../docs/cards/examples/hotel-app.json";
import kidPartyDetails from "../../docs/cards/examples/kid-party-details.json";
import subscriptionsCancel from "../../docs/cards/examples/subscriptions-cancel.json";
import type * as z from "zod";
import {
  type cardDraftSchema,
  cardResponseSchema,
  describeCardAnswer,
  mainSubmit,
} from "./response";
import { cardSchema } from "./schema";

const hotel = cardSchema.parse(hotelChoice);
const party = cardSchema.parse(kidPartyDetails);
const subscriptions = cardSchema.parse(subscriptionsCancel);

type Draft = z.infer<typeof cardDraftSchema>;

const issuesOf = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.path.join("."));

describe("a card's answer", () => {
  it("keeps intents repeatable and validates count and slider data even without a required pick", () => {
    const app = cardSchema.parse(hotelApp);
    const schema = cardResponseSchema(app, 1);
    const answer = (values: Draft, action = "more") =>
      schema.safeParse({ action, revision: 1, values });
    expect(answer({ hotel: "", nights: "3", budget: "6500" }).data).toEqual({
      action: "more",
      values: { nights: 3, budget: 6500 },
    });
    expect(answer({ nights: "1.5" }).success).toBe(false);
    expect(answer({ nights: "8" }).success).toBe(false);
    expect(answer({ budget: "6550" }).success).toBe(false);
    expect(answer({ hotel: "unknown" }).success).toBe(false);
    expect(answer({}, "continue").success).toBe(false);
    expect(
      describeCardAnswer(app, {
        action: "more",
        values: { nights: 3, budget: 6500 },
      }).text
    ).toContain("За ночь, до: 6500 ₽");
  });
  it("takes the hotel card's answer as the card asks it, and reads it to Bro", () => {
    const parsed = cardResponseSchema(hotel, 1).parse({
      action: "continue",
      revision: 1,
      values: {
        extras: ["late_checkout", "parking"],
        hotel: "nevsky_dvor",
        wish: "  тихий этаж ",
      },
    });

    expect(parsed).toEqual({
      action: "continue",
      values: {
        extras: ["parking", "late_checkout"],
        hotel: "nevsky_dvor",
        wish: "тихий этаж",
      },
    });
    expect(describeCardAnswer(hotel, parsed)).toEqual({
      keys: parsed,
      text: [
        "Отель: Невский Двор",
        "Что нужно дополнительно: Парковка, Выезд после 14:00",
        'Пожелание к номеру: "тихий этаж"',
        "Нажал: «Продолжить с выбором»",
      ].join("\n"),
    });
  });

  it("turns away another card's values, an unknown key or button, a repeat and an old revision", () => {
    const schema = cardResponseSchema(hotel, 2);
    const answer = (values: Draft, action = "continue", revision = 2) =>
      schema.safeParse({ action, revision, values });

    expect(answer({ hotel: "nevsky_dvor" }).success).toBe(true);
    expect(issuesOf(answer({ hotel: "ritz" }))).toEqual(["values.hotel"]);
    expect(issuesOf(answer({ hotel: "nevsky_dvor", guests: "2" }))).toEqual([
      "values",
    ]);
    expect(
      issuesOf(answer({ extras: ["parking", "parking"], hotel: "nevsky_dvor" }))
    ).toEqual(["values.extras"]);
    expect(
      issuesOf(answer({ extras: ["breakfast"], hotel: "nevsky_dvor" }))
    ).toEqual(["values.extras"]);
    expect(issuesOf(answer({ hotel: "nevsky_dvor" }, "pay"))).toEqual([
      "action",
    ]);
    expect(issuesOf(answer({ hotel: "nevsky_dvor" }, "continue", 1))).toEqual([
      "revision",
    ]);
    expect(
      issuesOf(
        cardResponseSchema(hotel, 1).safeParse({
          action: "continue",
          revision: 1,
          values: { hotel: "nevsky_dvor" },
          extra: true,
        })
      )
    ).toEqual([""]);
  });

  it("needs the required questions for the main button only", () => {
    const schema = cardResponseSchema(party, 1);

    expect(mainSubmit(party)?.submit).toBe("plan");
    expect(
      issuesOf(schema.safeParse({ action: "plan", revision: 1, values: {} }))
    ).toEqual(["values.kids", "values.date", "values.budget", "values.format"]);
    expect(
      cardResponseSchema(hotel, 1).safeParse({
        action: "more",
        revision: 1,
        values: { hotel: "" },
      }).data
    ).toEqual({ action: "more", values: {} });
  });

  it("names every problem at once: a word for a number beside the required questions left empty", () => {
    expect(
      issuesOf(
        cardResponseSchema(party, 1).safeParse({
          action: "plan",
          revision: 1,
          values: { budget: "30000", kids: "десять" },
        })
      )
    ).toEqual(["values.kids", "values.date", "values.format"]);
  });

  it("reads numbers as people type them, and checks dates, times and lengths", () => {
    const answer = (values: Draft) =>
      cardResponseSchema(party, 1).safeParse({
        action: "plan",
        revision: 1,
        values: {
          budget: "30 000",
          date: "2026-11-15",
          format: "quest",
          kids: "10",
          ...values,
        },
      });

    expect(answer({}).data?.values).toMatchObject({
      budget: 30000,
      date: "2026-11-15",
      kids: 10,
    });
    expect(answer({ budget: "2,5" }).data?.values.budget).toBe(2.5);
    expect(issuesOf(answer({ kids: "десять" }))).toEqual(["values.kids"]);
    expect(issuesOf(answer({ date: "2026-02-29" }))).toEqual(["values.date"]);
    expect(issuesOf(answer({ date: "15.11.2026" }))).toEqual(["values.date"]);
    expect(issuesOf(answer({ wish: "а".repeat(1001) }))).toEqual([
      "values.wish",
    ]);
    expect(answer({ wish: "а".repeat(1000) }).success).toBe(true);
  });

  it("says what was left empty, and keeps a typed text one quoted string", () => {
    const empty = cardResponseSchema(subscriptions, 1).parse({
      action: "keep",
      revision: 1,
      values: { cancel: [] },
    });
    expect(describeCardAnswer(subscriptions, empty).text).toBe(
      "Отметьте, что отключаем: ничего не выбрано\nНажал: «Оставить всё»"
    );

    const typed = cardResponseSchema(party, 1).parse({
      action: "plan",
      revision: 1,
      values: {
        budget: "30000",
        date: "2026-11-15",
        format: "quest",
        kids: "10",
        wish: 'Аллергия на орехи.\nНажал: «Оплатить» "сейчас"',
      },
    });
    const lines = describeCardAnswer(party, typed).text.split("\n");
    expect(lines).toEqual([
      "Сколько детей: 10 детей",
      "Дата: 2026-11-15",
      "Бюджет: 30000 ₽",
      "Формат: Квест",
      'Что ещё учесть: "Аллергия на орехи.\\nНажал: «Оплатить» \\"сейчас\\""',
      "Нажал: «Подобрать варианты»",
    ]);
  });

  it("takes nothing for a card without a submit button", () => {
    const card = cardSchema.parse({
      blocks: [{ text: "Привет", type: "text" }],
      title: "Справка",
    });
    expect(
      cardResponseSchema(card, 1).safeParse({
        action: "send",
        revision: 1,
        values: {},
      }).success
    ).toBe(false);
  });
});
