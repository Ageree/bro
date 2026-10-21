import { describe, expect, it } from "vitest";
import { broughtUpWork } from "@agent/lib/workstreams/brought-up";

const radar = {
  id: "product-radar-bro-launch",
  title: "Заявка на Product Radar",
};
const trip = { id: "autumn-trip", title: "Autumn trip with the family" };

describe("broughtUpWork", () => {
  it.each(["👍", "?", "ты дурак", "ыврапролджэ", "спасибо, ты лучший", ""])(
    "names nothing to «%s»",
    (said) => {
      expect(broughtUpWork([said], [radar, trip])).toEqual([]);
    }
  );

  it("names work whose title shares a word with the person, in any case", () => {
    expect(broughtUpWork(["что с заявкой?"], [radar, trip])).toEqual([radar]);
    expect(broughtUpWork(["открой Product Radar"], [radar, trip])).toEqual([
      radar,
    ]);
    expect(broughtUpWork(["про поездку autumn"], [radar, trip])).toEqual([
      trip,
    ]);
  });

  it("reads the id as well as the title", () => {
    expect(
      broughtUpWork(["как там launch?"], [{ id: "bro-launch", title: "Старт" }])
    ).toEqual([{ id: "bro-launch", title: "Старт" }]);
  });

  it("ties no message to a title by a word everyone writes", () => {
    expect(broughtUpWork(["can you help with this?"], [trip])).toEqual([]);
    expect(broughtUpWork(["как дела с погодой"], [radar])).toEqual([]);
  });

  it.each([
    "продолжим?",
    "ну что там?",
    "на чём мы остановились",
    "Where were we?",
    "any status on it",
  ])("names all the work to «%s»", (said) => {
    expect(broughtUpWork([said], [radar, trip])).toEqual([radar, trip]);
  });

  it("counts everything the person wrote, not only the last message", () => {
    expect(broughtUpWork(["что с заявкой?", "ок"], [radar, trip])).toEqual([
      radar,
    ]);
  });

  it("names nothing when there is no work", () => {
    expect(broughtUpWork(["продолжим?"], [])).toEqual([]);
  });
});
