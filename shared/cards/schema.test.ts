import { describe, expect, it } from "vitest";
import flightBooked from "../../docs/cards/examples/flight-booked.json";
import hotelChoice from "../../docs/cards/examples/hotel-choice.json";
import kidPartyDetails from "../../docs/cards/examples/kid-party-details.json";
import meetingSlot from "../../docs/cards/examples/meeting-slot.json";
import restaurantsCompare from "../../docs/cards/examples/restaurants-compare.json";
import subscriptionsCancel from "../../docs/cards/examples/subscriptions-cancel.json";
import weekendItinerary from "../../docs/cards/examples/weekend-itinerary.json";
import { blockSchema, cardSchema } from "./schema";

const examples = [
  { name: "flight-booked", card: flightBooked },
  { name: "hotel-choice", card: hotelChoice },
  { name: "kid-party-details", card: kidPartyDetails },
  { name: "meeting-slot", card: meetingSlot },
  { name: "subscriptions-cancel", card: subscriptionsCancel },
  { name: "restaurants-compare", card: restaurantsCompare },
  { name: "weekend-itinerary", card: weekendItinerary },
];

describe("card schema", () => {
  it.each(examples)("accepts the example $name", ({ card }) => {
    expect(cardSchema.safeParse(card).success).toBe(true);
  });

  it("uses every block of the catalog in the examples", () => {
    const catalog = blockSchema.options.map(
      (option) => option.shape.type.value
    );
    const used = new Set(
      examples.flatMap(({ card }) =>
        cardSchema.parse(card).blocks.map((block) => block.type)
      )
    );
    expect(catalog.filter((type) => !used.has(type))).toEqual([]);
  });

  it("refuses a link that is not https and a field the catalog lacks", () => {
    const card = {
      title: "Тест",
      blocks: [{ type: "text", text: "Привет" }],
    };
    expect(cardSchema.safeParse(card).success).toBe(true);
    expect(
      cardSchema.safeParse({
        ...card,
        actions: [{ label: "Открыть", href: "http://example.com" }],
      }).success
    ).toBe(false);
    expect(
      cardSchema.safeParse({
        ...card,
        actions: [{ label: "Открыть", href: "javascript:alert(1)" }],
      }).success
    ).toBe(false);
    expect(
      cardSchema.safeParse({
        ...card,
        blocks: [{ type: "text", text: "Привет", html: "<b>x</b>" }],
      }).success
    ).toBe(false);
  });

  it("refuses a table whose row does not match its columns", () => {
    const table = {
      type: "table",
      columns: ["А", "Б"],
      rows: [["1", "2", "3"]],
    };
    expect(
      cardSchema.safeParse({ title: "Тест", blocks: [table] }).success
    ).toBe(false);
  });

  it("keeps the answers of a card keyed by unique ids and sendable", () => {
    const field = {
      type: "field",
      id: "kids",
      label: "Сколько детей",
      input: "number",
    };
    const send = { label: "Отправить", submit: "send" };
    const card = { title: "Тест", blocks: [field], actions: [send] };
    expect(cardSchema.safeParse(card).success).toBe(true);
    expect(cardSchema.safeParse({ ...card, actions: [] }).success).toBe(false);
    expect(
      cardSchema.safeParse({ ...card, blocks: [field, field] }).success
    ).toBe(false);
    expect(
      cardSchema.safeParse({
        ...card,
        actions: [send, { label: "Ещё", submit: "send" }],
      }).success
    ).toBe(false);
  });

  it("refuses a choice whose options repeat or whose initial is not an option", () => {
    const choice = {
      type: "choice",
      id: "pick",
      label: "Выбор",
      options: [
        { value: "a", title: "А" },
        { value: "b", title: "Б" },
      ],
    };
    const send = { label: "Отправить", submit: "send" };
    const card = (block: object) => ({
      title: "Тест",
      blocks: [block],
      actions: [send],
    });
    expect(cardSchema.safeParse(card(choice)).success).toBe(true);
    expect(
      cardSchema.safeParse(card({ ...choice, initial: ["c"] })).success
    ).toBe(false);
    expect(
      cardSchema.safeParse(card({ ...choice, initial: ["a", "b"] })).success
    ).toBe(false);
    expect(
      cardSchema.safeParse(
        card({ ...choice, initial: ["a", "b"], multiple: true })
      ).success
    ).toBe(true);
    expect(
      cardSchema.safeParse(
        card({
          ...choice,
          options: [
            { value: "a", title: "А" },
            { value: "a", title: "Б" },
          ],
        })
      ).success
    ).toBe(false);
  });
});
