import { describe, expect, it } from "vitest";
import {
  distanceM,
  type FencePoint,
  liveKeyOf,
  placeStep,
  pointSide,
} from "@shared/location/geometry";
import { emptyPlaceState, type PlaceState } from "@shared/subscriptions/place";

const center = { lat: 55.7512, lon: 37.6184 };
/** About 2 km north. */
const far = { lat: 55.7692, lon: 37.6184 };
const now = new Date("2026-10-15T10:00:00.000Z");
const minute = 60_000;
const longAgo = new Date(now.getTime() - 60 * minute);

function at(offsetMs: number, where = center, extra: Partial<FencePoint> = {}) {
  return {
    accuracyM: 20,
    arriveAllowed: true,
    leaveAllowed: true,
    live: false,
    recordedAt: new Date(now.getTime() + offsetMs),
    ...where,
    ...extra,
  };
}

function step(
  state: PlaceState,
  point: FencePoint,
  options: { on?: "arrive" | "leave"; createdAt?: Date; when?: Date } = {}
) {
  return placeStep(state, point, {
    center,
    createdAt: options.createdAt ?? longAgo,
    now: options.when ?? point.recordedAt,
    on: options.on ?? "arrive",
    radiusM: 150,
  });
}

const outside: PlaceState = { ...emptyPlaceState, inside: false };
const insideState: PlaceState = { ...emptyPlaceState, inside: true };

describe("geometry of shared locations", () => {
  it("keys one live share alike from strings and numbers", () => {
    expect(liveKeyOf(-100_123, 42)).toBe(liveKeyOf("-100123", "42"));
  });

  it("tells sides with a band where jitter never fires", () => {
    expect(distanceM(center, far)).toBeGreaterThan(1_900);
    expect(pointSide({ accuracyM: 20, distanceM: 100, radiusM: 150 })).toBe(
      "in"
    );
    expect(pointSide({ accuracyM: null, distanceM: 100, radiusM: 150 })).toBe(
      "in"
    );
    expect(pointSide({ accuracyM: 100, distanceM: 100, radiusM: 150 })).toBe(
      "edge"
    );
    expect(pointSide({ accuracyM: 20, distanceM: 200, radiusM: 150 })).toBe(
      "edge"
    );
    expect(pointSide({ accuracyM: 20, distanceM: 260, radiusM: 150 })).toBe(
      "out"
    );
    expect(pointSide({ accuracyM: 600, distanceM: 5, radiusM: 150 })).toBe(
      "unusable"
    );
  });

  it("fires an arrival on a point the person sent, at once", () => {
    const result = step(outside, at(0));
    expect(result.hit).toEqual({ at: now, movedFar: false });
    expect(result.state.inside).toBe(true);
  });

  it("drops a late point and a live jump faster than 200 km/h", () => {
    const later = step(outside, at(0, far, { live: true })).state;
    expect(step(later, at(-minute)).state).toBe(later);
    // 2 km in 10 s is 720 km/h.
    expect(step(later, at(10_000, center, { live: true })).state).toBe(later);
  });

  it("takes points after a flight, and a point the person sent at once", () => {
    // Moscow at 08:00, then Sochi (about 1 360 km) three hours later.
    const moscow = { lat: 55.7512, lon: 37.6184 };
    const before = placeStep(
      outside,
      { ...at(-3 * 60 * minute, moscow), live: true },
      {
        center: { lat: 43.5855, lon: 39.7231 },
        createdAt: longAgo,
        now,
        on: "arrive",
        radiusM: 150,
      }
    ).state;
    const sochi = { lat: 43.5855, lon: 39.7231 };
    const options = {
      center: sochi,
      createdAt: longAgo,
      now,
      on: "arrive" as const,
      radiusM: 150,
    };
    // A point the person sent fires at once.
    expect(placeStep(before, at(0, sochi), options).hit).toBeDefined();
    // A live edit, far past the old anchor, is taken.
    expect(
      placeStep(before, at(0, sochi, { live: true }), options).state.last
    ).toMatchObject({ lat: sochi.lat });
    // A wrong anchor a few seconds old vetoes a live edit; one sent does not.
    const jumped = step(outside, at(0, far, { live: true })).state;
    expect(step(jumped, at(10_000)).hit).toBeDefined();
  });

  it("moves the state on a point older than 10 minutes but never fires", () => {
    const result = step(outside, at(0), {
      when: new Date(now.getTime() + 11 * minute),
    });
    expect(result.hit).toBeUndefined();
    expect(result.state.inside).toBe(true);
  });

  it("needs two live edits on the new side, 30 s apart", () => {
    const first = step(outside, at(0, center, { live: true }));
    expect(first.hit).toBeUndefined();
    expect(first.state.pending?.side).toBe("in");
    const soon = step(first.state, at(10_000, center, { live: true }));
    expect(soon.hit).toBeUndefined();
    const second = step(first.state, at(40_000, center, { live: true }));
    expect(second.hit?.at).toEqual(new Date(now.getTime() + 40_000));
  });

  it("never says a leave from a point without that right", () => {
    const result = step(insideState, at(0, far, { leaveAllowed: false }), {
      on: "leave",
    });
    expect(result.hit).toBeUndefined();
    expect(result.state.inside).toBe(true);
    const own = step(insideState, at(0, far), { on: "leave" });
    expect(own.hit).toEqual({ at: now, movedFar: true });
  });

  it("from no side yet fires only for an older reminder or after a live edit outside", () => {
    expect(step(emptyPlaceState, at(0)).hit).toBeDefined();
    expect(
      step(emptyPlaceState, at(0), {
        createdAt: new Date(now.getTime() - minute),
      }).hit
    ).toBeUndefined();
    const live = { live: true };
    const pending = step(emptyPlaceState, at(0, center, live)).state;
    expect(step(pending, at(40_000, center, live)).hit).toBeUndefined();
    const wentOut = step(emptyPlaceState, at(-20 * minute, far, live)).state;
    const back = step({ ...wentOut, inside: null }, at(0, center, live)).state;
    expect(step(back, at(40_000, center, live)).hit).toBeDefined();
  });

  it("marks an arrival after a real trip as one that may wake the person", () => {
    const away = step(outside, at(-30 * minute, far), { when: now }).state;
    expect(step(away, at(0)).hit?.movedFar).toBe(true);
  });
});
