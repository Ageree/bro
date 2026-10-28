import * as z from "zod";
import { applicationOrigin } from "@shared/environment/origin";

// The weather from the Norwegian Meteorological Institute's locationforecast (api.met.no): no key, free for
// any use under CC BY 4.0 with the credit «MET Norway», an identifying User-Agent asked for. Through web
// search the voice told rain no forecast model showed (Kazan, 2 runs in 6) and a different Moscow day each
// time; from forecast data the same answer came every time (probe 28.10, Open-Meteo: its free tier is for
// non-commercial use only, hence MET Norway). Hourly for about two and a half days, six-hourly after.

const forecastUrl =
  "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const requestTimeoutMs = 2500;
/** MET asks clients to cache; a forecast is updated about hourly. */
const keptMs = 30 * 60_000;
const daysTold = 3;

const timeseriesSchema = z.array(
  z.object({
    time: z.string(),
    data: z.object({
      instant: z.object({
        details: z.object({
          air_temperature: z.number(),
          wind_speed: z.number().optional(),
        }),
      }),
      next_1_hours: z
        .object({
          summary: z.object({ symbol_code: z.string() }),
          details: z.object({ precipitation_amount: z.number().optional() }),
        })
        .optional(),
      next_6_hours: z
        .object({
          summary: z.object({ symbol_code: z.string() }),
          details: z.object({ precipitation_amount: z.number().optional() }),
        })
        .optional(),
    }),
  })
);
const forecastSchema = z.object({
  properties: z.object({ timeseries: timeseriesSchema }),
});

type Timeseries = z.infer<typeof timeseriesSchema>;

const kept = new Map<
  string,
  { readonly series: Timeseries; readonly until: number }
>();

function userAgent() {
  try {
    return `Bro/1.0 (personal assistant, weather; contact: ${applicationOrigin()})`;
  } catch {
    return "Bro/1.0 (personal assistant, weather)";
  }
}

/** MET's forecast for a point, kept for half an hour per point of a kilometre or so. */
async function forecastAt(
  point: { readonly lat: number; readonly lon: number },
  signal: AbortSignal
) {
  // MET asks for no more than four decimals; two keep a city's forecast one cache entry.
  const lat = point.lat.toFixed(2);
  const lon = point.lon.toFixed(2);
  const key = `${lat},${lon}`;
  const known = kept.get(key);
  if (known && known.until > Date.now()) return known.series;
  const url = new URL(forecastUrl);
  url.searchParams.set("lat", lat);
  url.searchParams.set("lon", lon);
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent() },
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
  });
  if (!response.ok)
    throw new Error(`MET Norway answered ${String(response.status)}`);
  const series = forecastSchema.parse(await response.json()).properties
    .timeseries;
  kept.set(key, { series, until: Date.now() + keptMs });
  return series;
}

const conditions: ReadonlyMap<string, string> = new Map([
  ["clearsky", "ясно"],
  ["fair", "малооблачно"],
  ["partlycloudy", "переменная облачность"],
  ["cloudy", "пасмурно"],
  ["fog", "туман"],
  ["lightrain", "небольшой дождь"],
  ["rain", "дождь"],
  ["heavyrain", "сильный дождь"],
  ["lightrainshowers", "небольшой ливень"],
  ["rainshowers", "ливень"],
  ["heavyrainshowers", "сильный ливень"],
  ["lightsleet", "небольшой мокрый снег"],
  ["sleet", "мокрый снег"],
  ["heavysleet", "сильный мокрый снег"],
  ["lightsleetshowers", "небольшой мокрый снег"],
  ["sleetshowers", "мокрый снег"],
  ["heavysleetshowers", "сильный мокрый снег"],
  ["lightsnow", "небольшой снег"],
  ["snow", "снег"],
  ["heavysnow", "сильный снег"],
  ["lightsnowshowers", "небольшой снег"],
  ["snowshowers", "снегопад"],
  ["heavysnowshowers", "сильный снегопад"],
]);

/** «lightrainshowers_day» as words; a thunderstorm whatever comes with it. */
function condition(symbol: string) {
  const plain = symbol.replace(/_(?:day|night|polartwilight)$/u, "");
  if (plain.includes("thunder")) return "гроза";
  return conditions.get(plain) ?? plain;
}

function degrees(value: number) {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${String(rounded)}°` : `${String(rounded)}°`;
}

function range(values: readonly number[]) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return Math.round(low) === Math.round(high)
    ? degrees(high)
    : `от ${degrees(low)} до ${degrees(high)}`;
}

/** The most frequent of the words, the first of them on a tie. */
function mostOf(words: readonly string[]) {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0];
}

/** The forecast as lines for the model: now, then today, tomorrow and the day after, by the local clock. */
export function weatherLines(
  series: Timeseries,
  input: { readonly now: Date; readonly timeZone: string }
) {
  const dayOf = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: input.timeZone,
    year: "numeric",
  });
  const hourOf = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: input.timeZone,
  });
  const label = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: input.timeZone,
    weekday: "long",
  });
  const lines: string[] = [];
  const first = series.find(
    (entry) =>
      new Date(entry.time) >= new Date(input.now.getTime() - 60 * 60_000)
  );
  if (first !== undefined) {
    const symbol =
      first.data.next_1_hours?.summary.symbol_code ??
      first.data.next_6_hours?.summary.symbol_code;
    lines.push(
      `Сейчас: ${degrees(first.data.instant.details.air_temperature)}${symbol ? `, ${condition(symbol)}` : ""}${first.data.instant.details.wind_speed === undefined ? "" : `, ветер ${String(Math.round(first.data.instant.details.wind_speed))} м/с`}.`
    );
  }
  const days = [
    ...new Set(
      series
        .map((entry) => dayOf.format(new Date(entry.time)))
        .filter((day) => day >= dayOf.format(input.now))
    ),
  ].slice(0, daysTold);
  for (const [index, day] of days.entries()) {
    const entries = series.filter(
      (entry) => dayOf.format(new Date(entry.time)) === day
    );
    const hour = (entry: Timeseries[number]) =>
      Number(hourOf.format(new Date(entry.time)));
    const daytime = entries.filter(
      (entry) => hour(entry) >= 9 && hour(entry) <= 21
    );
    const night = entries.filter((entry) => hour(entry) <= 6);
    // Hourly entries carry an hour's rain, six-hourly ones six hours'.
    const rain = entries.reduce(
      (sum, entry) =>
        sum +
        (entry.data.next_1_hours?.details.precipitation_amount ??
          entry.data.next_6_hours?.details.precipitation_amount ??
          0),
      0
    );
    const sky = mostOf(
      (daytime.length > 0 ? daytime : entries).flatMap((entry) => {
        const symbol =
          entry.data.next_1_hours?.summary.symbol_code ??
          entry.data.next_6_hours?.summary.symbol_code;
        return symbol === undefined ? [] : [condition(symbol)];
      })
    );
    const winds = entries.flatMap((entry) =>
      entry.data.instant.details.wind_speed === undefined
        ? []
        : [entry.data.instant.details.wind_speed]
    );
    const name = ["Сегодня", "Завтра", "Послезавтра"][index] ?? "";
    const parts = [
      daytime.length > 0
        ? `днём ${range(daytime.map((entry) => entry.data.instant.details.air_temperature))}`
        : undefined,
      night.length > 0
        ? `ночью ${range(night.map((entry) => entry.data.instant.details.air_temperature))}`
        : undefined,
      sky,
      rain >= 0.5
        ? `осадки около ${String(Math.round(rain))} мм`
        : "без осадков",
      winds.length > 0
        ? `ветер до ${String(Math.round(Math.max(...winds)))} м/с`
        : undefined,
    ].filter((part) => part !== undefined);
    lines.push(
      `${name}, ${label.format(new Date(entries[0]?.time ?? input.now))}: ${parts.join(", ")}.`
    );
  }
  return lines.join("\n");
}

/** The forecast for a place as lines for the model. */
export async function weatherAt(
  point: { readonly lat: number; readonly lon: number },
  input: { readonly now: Date; readonly timeZone: string },
  signal: AbortSignal
) {
  return weatherLines(await forecastAt(point, signal), input);
}
