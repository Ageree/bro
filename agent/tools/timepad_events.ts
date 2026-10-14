/**
 * Looks up events on Timepad (lectures, concerts, workshops, meetups,
 * excursions) through its public API: a search by city, words, dates and
 * price, or one event in full by its id. Read-only: buying a ticket stays a
 * browser errand on the event's page.
 *
 * Present only where TIMEPAD_API_KEY is set, and only in interactive turns:
 * Bro's own mail checks and schedules do not search on what a letter says.
 * Nothing here logs a query: it can name what the person is into.
 */

import { defineDynamic, defineTool } from "eve/tools";
import { Agent, fetch } from "undici";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { env } from "@shared/environment";

const apiBase = "https://api.timepad.ru/v1";
const requestTimeoutMs = 15_000;
const defaultLimit = 8;
const maximumLimit = 20;
/**
 * A search without an end date looks this far ahead: Timepad keeps
 * recordings of past lectures dated 2050, and they are not events to go to.
 */
const defaultWindowDays = 60;
const dayMs = 86_400_000;
/**
 * Timepad reads a bound's wall time as Moscow's whatever zone it names (a
 * UTC `…Z` bound let in events three hours early), so bounds are written in
 * Moscow time, as its own dates are: a date alone means its day there.
 */
const moscowOffsetMs = 3 * 3_600_000;
const dayStart = "T00:00:00+03:00";
const dayEnd = "T23:59:59+03:00";
/**
 * Timepad's Cloudflare answers HTTP/1.1, which Node's `fetch` speaks, with a
 * bare «403 forbidden» whatever the headers, and lets HTTP/2 through (14.10,
 * curl both ways from a cloud session): the API is asked over HTTP/2.
 */
const timepadDispatcher = new Agent({ allowH2: true });
const shortTextChars = 300;
const fullTextChars = 2500;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .describe("A day as YYYY-MM-DD");

const inputSchema = z.object({
  city: z
    .string()
    .max(80)
    .optional()
    .describe(
      "The city in Russian, as Timepad names it: «Москва», «Санкт-Петербург». Leave out for events anywhere, online ones included."
    ),
  eventId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Read one event in full (its description, organiser, tickets) by the id a search returned; the other fields are then ignored."
    ),
  from: isoDate
    .optional()
    .describe("The first day of events, YYYY-MM-DD; leave out for from now."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(maximumLimit)
    .optional()
    .describe(
      `How many events to return, ${String(defaultLimit)} if left out.`
    ),
  maxPriceRub: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "The highest ticket price in roubles; 0 for free events only. Leave out when the person set no budget."
    ),
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Words the event's title or description has: «джаз», «стендап», «лекция по истории». Short is better: one or two words."
    ),
  to: isoDate
    .optional()
    .describe(
      `The last day of events, YYYY-MM-DD; leave out for ${String(defaultWindowDays)} days ahead.`
    ),
});

type TimepadInput = z.infer<typeof inputSchema>;

const eventSchema = z.object({
  age_limit: z.coerce.string().nullish(),
  categories: z.array(z.object({ name: z.string() })).nullish(),
  description_html: z.string().nullish(),
  description_short: z.string().nullish(),
  ends_at: z.string().nullish(),
  id: z.number(),
  location: z
    .object({
      address: z.string().nullish(),
      city: z.string().nullish(),
    })
    .nullish(),
  name: z.string(),
  organization: z.object({ name: z.string() }).nullish(),
  registration_data: z
    .object({
      is_registration_open: z.boolean().nullish(),
      price_max: z.number().nullish(),
      price_min: z.number().nullish(),
    })
    .nullish(),
  starts_at: z.string().nullish(),
  url: z.string().nullish(),
});

type TimepadEvent = z.infer<typeof eventSchema>;

const searchSchema = z.object({
  total: z.number().optional(),
  values: z.array(eventSchema).default([]),
});

const listFields =
  "location,description_short,ends_at,registration_data,age_limit";
const fullFields = `${listFields},organization`;

class TimepadError extends Error {
  override readonly name = "TimepadError";
}

const timepadEvents = defineTool({
  description:
    "Find events on Timepad: lectures, concerts, workshops, meetups, excursions, festivals and other events in Russian cities, with their dates, address, price and whether registration is open. Use it when the person asks what is on, where to go, or about an event on timepad.ru; web_search remains for theatres, cinemas and big venues Timepad does not sell. Each event comes with its Timepad page: link it as [name](its URL). Read one event in full with eventId. This tool only reads: registering or buying a ticket is done on the event's page.",
  inputSchema,
  async execute(input, ctx) {
    const apiKey = env.TIMEPAD_API_KEY;
    if (apiKey === undefined) {
      return "Timepad is not set up on this deployment. Search the web instead.";
    }
    const signal = AbortSignal.any([
      ctx.abortSignal,
      AbortSignal.timeout(requestTimeoutMs),
    ]);
    try {
      if (input.eventId !== undefined) {
        const event = eventSchema.parse(
          await readTimepad(
            `${apiBase}/events/${String(input.eventId)}`,
            new URLSearchParams({ fields: fullFields }),
            apiKey,
            signal
          )
        );
        return describeEvent(event, true);
      }
      const found = searchSchema.parse(
        await readTimepad(
          `${apiBase}/events`,
          searchParameters(input, new Date()),
          apiKey,
          signal
        )
      );
      return formatSearch(found.values, found.total);
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      // The status is for the log: the model repeats a reason to the person.
      console.warn("[timepad] request failed", {
        cause: error instanceof TimepadError ? error.message : error,
      });
      return input.eventId === undefined
        ? "Timepad could not be searched right now. Never quote a service, a status code or an error text to the person. Search the web for the events instead, or try once more with fewer conditions."
        : "This event could not be read from Timepad: the id may be wrong or the event closed. Never quote a status code to the person; search again to find it.";
    }
  },
});

/** The search's query string; `now` is when a search without dates starts. */
function searchParameters(input: TimepadInput, now: Date) {
  const from =
    input.from === undefined
      ? moscowTime(now.getTime())
      : `${input.from}${dayStart}`;
  const to =
    input.to === undefined
      ? moscowTime(Date.parse(from) + defaultWindowDays * dayMs)
      : `${input.to}${dayEnd}`;
  const parameters = new URLSearchParams({
    fields: listFields,
    limit: String(input.limit ?? defaultLimit),
    sort: "+starts_at",
    starts_at_max: to,
    starts_at_min: from,
  });
  const city = input.city?.trim();
  if (city) parameters.set("cities", city);
  const query = input.query?.trim();
  if (query) parameters.set("keywords", query);
  if (input.maxPriceRub !== undefined) {
    parameters.set("price_max", String(input.maxPriceRub));
  }
  return parameters;
}

function moscowTime(ms: number) {
  return `${new Date(ms + moscowOffsetMs).toISOString().slice(0, 19)}+03:00`;
}

async function readTimepad(
  url: string,
  parameters: URLSearchParams,
  apiKey: string,
  signal: AbortSignal
) {
  const response = await fetch(`${url}?${parameters.toString()}`, {
    dispatcher: timepadDispatcher,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    signal,
  });
  if (!response.ok) {
    throw new TimepadError(`Timepad answered ${String(response.status)}`);
  }
  return response.json();
}

function formatSearch(events: readonly TimepadEvent[], total?: number) {
  if (events.length === 0) {
    return "No events on Timepad match. Try fewer words, another day or no price limit, or search the web.";
  }
  const heading =
    total !== undefined && total > events.length
      ? `Timepad has ${String(total)} matching events; the first ${String(events.length)} by date:`
      : `Timepad events by date:`;
  return [heading, ...events.map((event) => describeEvent(event, false))].join(
    "\n\n"
  );
}

function describeEvent(event: TimepadEvent, full: boolean) {
  const place = [event.location?.city, firstLine(event.location?.address)]
    .filter(Boolean)
    .join(", ");
  const about = full
    ? (plainText(event.description_html) ?? plainText(event.description_short))
    : plainText(event.description_short);
  const lines = [
    `id ${String(event.id)}: ${plainText(event.name) ?? event.name}`,
    `when: ${[event.starts_at, event.ends_at].filter(Boolean).join(" – ") || "not given"}`,
    `where: ${place || "not given (may be online)"}`,
    `price: ${price(event.registration_data)}`,
    ...(event.registration_data?.is_registration_open === false
      ? ["registration: closed"]
      : []),
    ...(event.age_limit ? [`age: ${event.age_limit}+`] : []),
    ...(event.categories?.length
      ? [`category: ${event.categories.map(({ name }) => name).join(", ")}`]
      : []),
    ...(full && event.organization
      ? [`organiser: ${plainText(event.organization.name) ?? ""}`]
      : []),
    ...(event.url ? [`page: ${event.url}`] : []),
    ...(about
      ? [`about: ${clip(about, full ? fullTextChars : shortTextChars)}`]
      : []),
  ];
  return lines.join("\n");
}

function price(registration: TimepadEvent["registration_data"]) {
  const minimum = registration?.price_min ?? undefined;
  const maximum = registration?.price_max ?? undefined;
  if (minimum === undefined && maximum === undefined) return "not given";
  const low = minimum ?? maximum ?? 0;
  const high = maximum ?? low;
  if (high === 0) return "free";
  return low === high ? `${String(low)} ₽` : `${String(low)}–${String(high)} ₽`;
}

function firstLine(text: string | null | undefined) {
  return plainText(text?.split(/\r?\n/u)[0]);
}

const namedEntities: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["laquo", "«"],
  ["lt", "<"],
  ["mdash", "—"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["quot", '"'],
  ["raquo", "»"],
]);

/** Timepad's names and descriptions come HTML-escaped, the full one as HTML. */
function plainText(text: string | null | undefined) {
  if (!text) return undefined;
  const plain = text
    .replaceAll(/<(?:br|\/p|\/div|\/li)\b[^>]*>/giu, "\n")
    .replaceAll(/<[^>]*>/gu, "")
    .replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }
      return namedEntities.get(code.toLowerCase()) ?? entity;
    })
    .replaceAll(/[ \t]+/gu, " ")
    .replaceAll(/\s*\n\s*/gu, "\n")
    .trim();
  return plain || undefined;
}

function clip(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      env.TIMEPAD_API_KEY === undefined
        ? null
        : resolveModeValue(context, { interactive: timepadEvents }),
  },
});
