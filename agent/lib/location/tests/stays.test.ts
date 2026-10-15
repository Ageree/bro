import { describe, expect, it } from "vitest";
import { probableParking, readHistory } from "@agent/lib/location/stays";

/**
 * The history of shared positions: stays of five minutes within 150 m,
 * trips between them with a mode guessed from the speed, a point sent on
 * its own, and where the car was probably left.
 */

const start = new Date("2026-10-15T08:00:00.000Z").getTime();
const minute = 60_000;
/** About 111 m of latitude. */
const step = 0.001;
const home = { lat: 55.75, lon: 37.6 };

let counter = 0;
function at(minutes: number, lat: number, lon = home.lon) {
  counter += 1;
  return {
    accuracyM: 10,
    address: null,
    id: `p${String(counter)}`,
    label: null,
    lat,
    lon,
    recordedAt: new Date(start + minutes * minute),
  };
}

/** Points every minute at one place, for `minutes` minutes from `from`. */
function stay(from: number, minutes: number, lat: number) {
  return Array.from({ length: minutes + 1 }, (_, index) =>
    at(from + index, lat + (index % 2) * 0.0002)
  );
}

/** A trip north at `kmh`, one point a minute, for `minutes`. */
function drive(from: number, minutes: number, lat: number, kmh: number) {
  const perMinute = (kmh / 60) * (step / 0.111);
  return Array.from({ length: minutes }, (_, index) =>
    at(from + index + 1, lat + perMinute * (index + 1))
  );
}

describe("the history of shared positions", () => {
  it("reads two stays and a car trip between, and where the car was left", () => {
    const parkedLat = home.lat + (40 / 60) * 10 * (step / 0.111);
    const points = [
      ...stay(0, 10, home.lat),
      ...drive(10, 10, home.lat, 40),
      ...stay(21, 30, parkedLat),
    ];
    const items = readHistory(points);
    expect(items.map((item) => item.kind)).toEqual(["stay", "trip", "stay"]);
    const [, trip, arrived] = items;
    expect(trip).toMatchObject({ kind: "trip", mode: "vehicle" });
    expect(trip?.kind === "trip" && trip.km).toBeGreaterThan(5);
    expect(arrived).toMatchObject({ afterDriving: true, kind: "stay" });
    const parking = probableParking(items);
    expect(parking?.at.getTime()).toBe(start + 20 * minute);
  });

  it("tells a bike ride and a walk by their speed", () => {
    const bike = readHistory([
      ...stay(0, 6, home.lat),
      ...drive(6, 20, home.lat, 18),
    ]);
    expect(bike.at(-1)).toMatchObject({ kind: "trip", mode: "bike" });
    expect(probableParking(bike)).toBeNull();
    const walk = readHistory([
      ...stay(0, 6, home.lat),
      ...drive(6, 20, home.lat, 4.5),
    ]);
    expect(walk.at(-1)).toMatchObject({ kind: "trip", mode: "walk" });
  });

  it("keeps points sent hours apart as points, not a trip", () => {
    const items = readHistory([
      at(0, home.lat),
      at(120, home.lat + 20 * step),
      at(300, home.lat),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["point", "point", "point"]);
  });

  it("breaks a trip at a silence of half an hour, without a lone stay edge", () => {
    const items = readHistory([
      ...stay(0, 10, home.lat),
      at(60, home.lat + 20 * step),
      at(150, home.lat + 40 * step),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["stay", "point", "point"]);
  });
});
