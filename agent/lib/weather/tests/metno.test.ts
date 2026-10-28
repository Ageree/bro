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

/** Six hours of MET's forecast, as it gives them past the first two and a half days. */
function sixHours(time: string, temperature: number, symbol: string, rain = 0) {
  return {
    time,
    data: {
      instant: { details: { air_temperature: temperature } },
      next_6_hours: {
        summary: { symbol_code: symbol },
        details: { precipitation_amount: rain },
      },
    },
  };
}

describe("the forecast for the days ahead", () => {
  it("tells the weekend from a Wednesday, each day past the day after tomorrow by its date", () => {
    // Told three days, the voice answered «на выходные прогноза пока нет» (prod 28.10).
    const series = [
      hour("2026-10-28T09:00:00Z", 6.4, "clearsky_day"),
      sixHours("2026-10-31T06:00:00Z", 3.1, "snow", 2.2),
      sixHours("2026-10-31T12:00:00Z", 1.8, "snow", 1.1),
      sixHours("2026-11-01T12:00:00Z", 0.2, "cloudy"),
    ];

    expect(
      weatherLines(series, {
        now: new Date("2026-10-28T09:20:00Z"),
        timeZone: "Europe/Moscow",
      }).split("\n")
    ).toEqual([
      "Сейчас: +6°, ясно, ветер 3 м/с.",
      "Сегодня, среда, 28 октября: днём +6°, ясно, без осадков, ветер до 3 м/с.",
      "Суббота, 31 октября: днём от +2° до +3°, снег, осадки около 3 мм.",
      "Воскресенье, 1 ноября: днём 0°, пасмурно, без осадков.",
    ]);
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
