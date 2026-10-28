import { describe, expect, it } from "vitest";
import { placeZone, weatherLines } from "@agent/lib/weather/metno";

/** One hour of MET's forecast. */
function hour(
  time: string,
  temperature: number,
  symbol: string,
  rain = 0,
  wind = 3
) {
  return {
    time,
    data: {
      instant: { details: { air_temperature: temperature, wind_speed: wind } },
      next_1_hours: {
        summary: { symbol_code: symbol },
        details: { precipitation_amount: rain },
      },
    },
  };
}

describe("the forecast as the voice's model reads it", () => {
  it("tells now, then each day's day and night range, sky, rain and wind on the person's clock", () => {
    const series = [
      hour("2026-10-28T09:00:00Z", 6.4, "clearsky_day"),
      hour("2026-10-28T12:00:00Z", 9.6, "fair_day"),
      hour("2026-10-28T15:00:00Z", 8.2, "clearsky_day"),
      // 01:00 and 03:00 of the 29th in Moscow.
      hour("2026-10-28T22:00:00Z", 2.6, "cloudy"),
      hour("2026-10-29T00:00:00Z", 1.9, "cloudy"),
      hour("2026-10-29T08:00:00Z", 4.1, "lightrain", 0.4, 6),
      hour("2026-10-29T11:00:00Z", 7.2, "lightrain", 0.5, 7),
      hour("2026-10-29T14:00:00Z", 6.8, "cloudy"),
    ];

    expect(
      weatherLines(series, {
        now: new Date("2026-10-28T09:20:00Z"),
        timeZone: "Europe/Moscow",
      })
    ).toBe(
      [
        "Сейчас: +6°, ясно, ветер 3 м/с.",
        "Сегодня, среда, 28 октября: днём от +6° до +10°, ясно, без осадков, ветер до 3 м/с.",
        "Завтра, четверг, 29 октября: днём от +4° до +7°, ночью от +2° до +3°, небольшой дождь, осадки около 1 мм, ветер до 7 м/с.",
      ].join("\n")
    );
  });
});

describe("the clock a place's forecast is told on", () => {
  const now = new Date("2026-10-28T09:00:00Z");

  it("is the person's own near them, and the place's own far away", () => {
    expect(placeZone({ lon: 49.1 }, "Europe/Moscow", now)).toBe(
      "Europe/Moscow"
    );
    // Vladivostok from Moscow: its «днём» on Moscow's clock was its night.
    expect(placeZone({ lon: 131.9 }, "Europe/Moscow", now)).toBe("Etc/GMT-9");
    expect(placeZone({ lon: -0.1 }, "Europe/Moscow", now)).toBe("Etc/GMT");
    expect(placeZone({ lon: -74 }, "Europe/Moscow", now)).toBe("Etc/GMT+5");
  });
});
