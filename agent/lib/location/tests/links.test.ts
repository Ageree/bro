import { describe, expect, it } from "vitest";
import { mapPointsIn } from "@agent/lib/location/links";

describe("map links in the person's words", () => {
  it("reads each map's order of coordinates", () => {
    const cases: readonly [string, number, number][] = [
      [
        "https://maps.apple.com/?ll=55.751244,37.618423&q=Дом",
        55.751244,
        37.618423,
      ],
      [
        "https://maps.apple.com/place?coordinate=55.75,37.61&name=Кафе",
        55.75,
        37.61,
      ],
      [
        "https://www.google.com/maps/place/X/@55.70,37.50,17z/data=!3d55.7512!4d37.6184",
        55.7512,
        37.6184,
      ],
      ["https://maps.google.com/?q=55.75,37.61", 55.75, 37.61],
      ["https://yandex.ru/maps/?pt=37.6184,55.7512&z=17", 55.7512, 37.6184],
      ["https://yandex.ru/maps/?ll=37.6184%2C55.7512&z=16", 55.7512, 37.6184],
      [
        "https://yandex.ru/maps/?rtext=55.70,37.50~55.7512,37.6184",
        55.7512,
        37.6184,
      ],
      ["https://2gis.ru/moscow/geo/4504/37.6184,55.7512", 55.7512, 37.6184],
      [
        "https://www.openstreetmap.org/?mlat=55.7512&mlon=37.6184",
        55.7512,
        37.6184,
      ],
      [
        "https://www.openstreetmap.org/#map=17/55.7512/37.6184",
        55.7512,
        37.6184,
      ],
      ["geo:55.7512,37.6184?q=дом", 55.7512, 37.6184],
    ];
    for (const [text, lat, lon] of cases) {
      expect([text, mapPointsIn(`вот ${text} тут`)[0]]).toEqual([
        text,
        expect.objectContaining({ lat, lon }),
      ]);
    }
    expect(
      mapPointsIn(
        "https://maps.apple.com/place?coordinate=55.75,37.61&name=Кафе"
      )[0]?.label
    ).toBe("Кафе");
  });

  it("gives nothing for other hosts, short links and impossible points", () => {
    expect(mapPointsIn("https://evil.example/maps/?ll=55.75,37.61")).toEqual(
      []
    );
    expect(mapPointsIn("https://maps.app.goo.gl/abc123")).toEqual([]);
    expect(mapPointsIn("https://yandex.ru/maps/-/CDqZ")).toEqual([]);
    expect(mapPointsIn("https://maps.apple.com/?ll=95,37.61")).toEqual([]);
  });
});
