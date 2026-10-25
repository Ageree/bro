import { describe, expect, it } from "vitest";
import type { BroMandate } from "./contract";
import { ownerSetCovers, placeWithin, samePlace } from "./owner-set";

const now = new Date("2026-10-25T12:00:00+03:00");

/** An errand for a dinner at 19:00 on Saturday at Pushkin, as code found it in the owner's words. */
const mandate: BroMandate = {
  at: "2026-10-31T19:00:00+03:00",
  details: null,
  durationMinutes: null,
  goal: "договорись с Борисом об ужине в субботу в 19 в Пушкине",
  ownerSaid: { amount: false, paysFor: [], place: true, time: true },
  place: "Пушкин",
  window: {
    from: "2026-10-31T19:00:00+03:00",
    to: "2026-10-31T21:00:00+03:00",
  },
};

const dinner = {
  end: "2026-10-31T21:00:00+03:00",
  place: "ресторан «Пушкин»",
  start: "2026-10-31T19:00:00+03:00",
  summary: "Ужин",
};

describe("ownerSetCovers", () => {
  it("takes the agreement the owner set: their start, their venue", () => {
    expect(ownerSetCovers(mandate, dinner, now)).toBe(true);
  });

  it.each([
    [
      "another start",
      {
        ...dinner,
        start: "2026-10-31T20:00:00+03:00",
        end: "2026-10-31T22:00:00+03:00",
      },
    ],
    ["another venue", { ...dinner, place: "Даблби" }],
    ["no venue", { ...dinner, place: undefined }],
    ["points", { ...dinner, items: ["Борис — торт"] }],
    ["a sum", { ...dinner, amountRub: 3000 }],
    [
      "an end past the meeting",
      { ...dinner, end: "2027-10-31T21:00:00+03:00" },
    ],
  ])("does not take an agreement with %s", (_case, proposal) => {
    expect(ownerSetCovers(mandate, proposal, now)).toBe(false);
  });

  it("takes no agreement of an errand with points or a sum", () => {
    expect(
      ownerSetCovers({ ...mandate, items: ["Борис — торт"] }, dinner, now)
    ).toBe(false);
  });

  it("takes nothing the owner's words did not set, nor a meeting begun", () => {
    expect(
      ownerSetCovers(
        {
          ...mandate,
          ownerSaid: { amount: false, paysFor: [], place: true, time: false },
        },
        dinner,
        now
      )
    ).toBe(false);
    expect(
      ownerSetCovers(
        {
          ...mandate,
          ownerSaid: { amount: false, paysFor: [], place: false, time: true },
        },
        dinner,
        now
      )
    ).toBe(false);
    expect(
      ownerSetCovers(mandate, dinner, new Date("2026-10-31T19:30:00+03:00"))
    ).toBe(false);
  });

  it("takes no meeting longer than the owner's words let it run", () => {
    const hour: BroMandate = {
      ...mandate,
      ownerSaid: {
        amount: false,
        longest: 60,
        paysFor: [],
        place: true,
        time: true,
      },
    };
    expect(ownerSetCovers(hour, dinner, now)).toBe(false);
    expect(
      ownerSetCovers(hour, { ...dinner, end: "2026-10-31T20:00:00+03:00" }, now)
    ).toBe(true);
  });

  it("takes a time inside the owner's window", () => {
    const evening: BroMandate = {
      ...mandate,
      at: null,
      place: null,
      ownerSaid: { amount: false, paysFor: [], place: false, time: true },
      window: {
        from: "2026-10-31T17:00:00+03:00",
        to: "2026-11-01T00:00:00+03:00",
      },
    };
    expect(ownerSetCovers(evening, { ...dinner, place: undefined }, now)).toBe(
      true
    );
    expect(ownerSetCovers(evening, dinner, now)).toBe(false);
  });
});

describe("placeWithin", () => {
  it("lets a place say nothing beyond the venue", () => {
    expect(placeWithin("в «Пушкине»", "ресторан «Пушкин» на Тверском")).toBe(
      true
    );
    expect(placeWithin("Пушкин, второй этаж", "ресторан «Пушкин»")).toBe(false);
    expect(samePlace("Пушкин", "ресторан «Пушкин»")).toBe(true);
    expect(samePlace("кафе", "кафе")).toBe(false);
    expect(samePlace("Пушкин, кв. 12", "Пушкин")).toBe(false);
    expect(samePlace("Пушкин 2", "Пушкин")).toBe(false);
  });
});
