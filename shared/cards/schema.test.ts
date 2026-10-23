import { describe, expect, it } from "vitest";
import flightBooked from "../../docs/cards/examples/flight-booked.json";
import restaurantsCompare from "../../docs/cards/examples/restaurants-compare.json";
import weekendItinerary from "../../docs/cards/examples/weekend-itinerary.json";
import { blockSchema, cardSchema } from "./schema";

const examples = [
  { name: "flight-booked", card: flightBooked },
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
});
