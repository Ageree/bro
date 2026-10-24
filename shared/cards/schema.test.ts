import { describe, expect, it } from "vitest";
import apartmentGallery from "../../docs/cards/examples/apartment-gallery.json";
import flightBooked from "../../docs/cards/examples/flight-booked.json";
import hotelChoicePhotos from "../../docs/cards/examples/hotel-choice-photos.json";
import hotelChoice from "../../docs/cards/examples/hotel-choice.json";
import hotelApp from "../../docs/cards/examples/hotel-app.json";
import kidPartyDetails from "../../docs/cards/examples/kid-party-details.json";
import meetingSlot from "../../docs/cards/examples/meeting-slot.json";
import restaurantsCompare from "../../docs/cards/examples/restaurants-compare.json";
import subscriptionsCancel from "../../docs/cards/examples/subscriptions-cancel.json";
import vacuumCompare from "../../docs/cards/examples/vacuum-compare.json";
import weekendIdeasPhotos from "../../docs/cards/examples/weekend-ideas-photos.json";
import weekendItinerary from "../../docs/cards/examples/weekend-itinerary.json";
import { type Card, blockSchema, cardSchema } from "./schema";

const examples = [
  { name: "hotel-app", card: hotelApp },
  { name: "apartment-gallery", card: apartmentGallery },
  { name: "flight-booked", card: flightBooked },
  { name: "hotel-choice-photos", card: hotelChoicePhotos },
  { name: "hotel-choice", card: hotelChoice },
  { name: "kid-party-details", card: kidPartyDetails },
  { name: "meeting-slot", card: meetingSlot },
  { name: "subscriptions-cancel", card: subscriptionsCancel },
  { name: "vacuum-compare", card: vacuumCompare },
  { name: "weekend-ideas-photos", card: weekendIdeasPhotos },
  { name: "restaurants-compare", card: restaurantsCompare },
  { name: "weekend-itinerary", card: weekendItinerary },
];

interface Row {
  readonly title: string;
  readonly photo?: { readonly url: string; readonly alt: string };
}

function listParses(rows: readonly Row[], layout: "rows" | "carousel") {
  return cardSchema.safeParse({
    title: "Тест",
    blocks: [{ type: "list", rows, layout }],
  }).success;
}

const photos = (count: number, block: number) =>
  Array.from({ length: count }, (_, n) => ({
    url: `https://example.com/${String(block)}-${String(n)}.jpg`,
    alt: "Фото",
  }));

const morePhoto = (name: string) => ({
  alt: `Фото ${name}`,
  url: `https://example.com/${name}.jpg`,
});
type Option = Extract<
  Card["blocks"][number],
  { type: "choice" }
>["options"][number];
const pick = (more: Option["more"], also: Partial<Option> = {}) => ({
  actions: [{ label: "Выбрать и забронировать", submit: "book" }],
  blocks: [
    {
      id: "hotel",
      label: "Какой отель берём",
      options: [
        { title: "NordKapp", value: "nordkapp", more, ...also },
        { title: "Апельсин", value: "apelsin", ...also },
      ],
      type: "choice",
    },
  ],
  title: "Отели",
});

describe("card schema", () => {
  it("requires bounded, aligned numeric controls and real priced targets", () => {
    expect(cardSchema.safeParse(hotelApp).success).toBe(true);
    const control = hotelApp.blocks[0];
    const check = (
      changes: Partial<Extract<Card["blocks"][number], { type: "field" }>>
    ) =>
      cardSchema.safeParse({
        ...hotelApp,
        blocks: [{ ...control, ...changes }, ...hotelApp.blocks.slice(1)],
      }).success;
    expect(check({ min: undefined })).toBe(false);
    expect(check({ min: 7, max: 7 })).toBe(false);
    expect(check({ step: 0.5 })).toBe(false);
    expect(check({ min: 1, max: 4, step: 2, initial: "1" })).toBe(false);
    expect(check({ initial: "8" })).toBe(false);
    expect(check({ target: "unknown" })).toBe(false);
    expect(
      cardSchema.safeParse({
        ...hotelApp,
        blocks: [...hotelApp.blocks, { ...control, id: "guests" }],
      }).success
    ).toBe(false);
  });
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
    const missingButton = cardSchema.safeParse({ ...card, actions: [] });
    expect(missingButton.error?.issues[0]?.path).toEqual(["actions"]);
    expect(missingButton.error?.issues[0]?.message).toContain(
      "needs a submit button"
    );
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
    const options = [
      { value: "a", title: "А" },
      { value: "b", title: "Б" },
    ];
    const card = {
      title: "Тест",
      blocks: [{ type: "choice", id: "pick", label: "Выбор", options }],
      actions: [{ label: "Отправить", submit: "send" }],
    };
    expect(cardSchema.safeParse(card).success).toBe(true);
    expect(
      cardSchema.safeParse({
        ...card,
        blocks: [{ ...card.blocks[0], initial: ["c"] }],
      }).success
    ).toBe(false);
    expect(
      cardSchema.safeParse({
        ...card,
        blocks: [{ ...card.blocks[0], initial: ["a", "b"] }],
      }).success
    ).toBe(false);
    expect(
      cardSchema.safeParse({
        ...card,
        blocks: [{ ...card.blocks[0], initial: ["a", "b"], multiple: true }],
      }).success
    ).toBe(true);
    expect(
      cardSchema.safeParse({
        ...card,
        blocks: [
          {
            ...card.blocks[0],
            options: [options[0], { value: "a", title: "Б" }],
          },
        ],
      }).success
    ).toBe(false);
  });

  it("shows photos on every row or on none, and a carousel only with photos", () => {
    const photo = { url: "https://example.com/a.jpg", alt: "Фото" };
    const withPhotos = [
      { title: "А", photo },
      { title: "Б", photo },
    ];
    const without = [{ title: "А" }, { title: "Б" }];
    const mixed = [{ title: "А", photo }, { title: "Б" }];
    expect(listParses(withPhotos, "rows")).toBe(true);
    expect(listParses(withPhotos, "carousel")).toBe(true);
    expect(listParses(mixed, "rows")).toBe(false);
    expect(listParses(without, "carousel")).toBe(false);
  });

  it("limits a gallery to two to eight photos and a card to eighteen", () => {
    const parse = (...counts: number[]) =>
      cardSchema.safeParse({
        title: "Тест",
        blocks: counts.map((count, block) => ({
          type: "gallery",
          photos: photos(count, block),
        })),
      }).success;
    expect(parse(1)).toBe(false);
    expect(parse(2)).toBe(true);
    expect(parse(9)).toBe(false);
    expect(parse(8, 5)).toBe(true);
    expect(parse(8, 8, 2)).toBe(true);
    expect(parse(8, 8, 3)).toBe(false);
  });
});

describe("«Подробнее» of a row or an option", () => {
  it("takes photos, facts, a text and a link, on any of the options", () => {
    expect(
      cardSchema.safeParse(
        pick({
          facts: [{ label: "Заезд", value: "с 14:00" }],
          href: "https://ostrovok.ru/hotel/nordkapp/",
          photos: [morePhoto("hall"), morePhoto("room")],
          text: "Тихий двор, до Невского три минуты.",
        })
      ).success
    ).toBe(true);
    expect(
      cardSchema.safeParse({
        blocks: [
          {
            rows: [{ more: { text: "Окна во двор" }, title: "Номер" }],
            type: "list",
          },
        ],
        title: "Номер",
      }).success
    ).toBe(true);
  });

  it("refuses one with nothing in it, a link that is not https, or too many photos", () => {
    expect(cardSchema.safeParse(pick({})).success).toBe(false);
    expect(
      cardSchema.safeParse(pick({ href: "http://ostrovok.ru/" })).success
    ).toBe(false);
    expect(
      cardSchema.safeParse(
        pick({
          photos: Array.from({ length: 9 }, (_, n) => morePhoto(String(n))),
        })
      ).success
    ).toBe(false);
  });

  it("counts its photos toward the card's eighteen, once each, and leaves the rows' own photo rule to the rows", () => {
    const many = (option: number) => ({
      photos: Array.from({ length: 8 }, (_, n) =>
        morePhoto(`${String(option)}-${String(n)}`)
      ),
    });
    const card = (count: number) => ({
      actions: [{ label: "Выбрать", submit: "book" }],
      blocks: [
        {
          id: "hotel",
          label: "Какой отель берём",
          options: Array.from({ length: count }, (_, n) => ({
            more: many(n),
            photo: morePhoto(`main-${String(n)}`),
            title: `Отель ${String(n)}`,
            value: `hotel_${String(n)}`,
          })),
          type: "choice",
        },
      ],
      title: "Отели",
    });
    expect(cardSchema.safeParse(card(2)).success).toBe(true);
    expect(cardSchema.safeParse(card(3)).success).toBe(false);
    const repeated = card(3);
    for (const option of repeated.blocks[0]?.options ?? []) {
      option.more = {
        photos: [option.photo, ...option.more.photos.slice(0, 4)],
      };
    }
    expect(cardSchema.safeParse(repeated).success).toBe(true);
    expect(
      cardSchema.safeParse(pick({ photos: [morePhoto("hall")] })).success
    ).toBe(true);
  });
});
