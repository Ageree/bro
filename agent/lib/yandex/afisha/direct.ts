import { z } from "zod";
import type { JsonValue } from "../operations";
import {
  afishaListingGraphql,
  afishaSearchGraphql,
  afishaSearchOperation,
} from "./search";

/** The wait for Afisha before the pool tab is asked instead. */
const directBudgetMs = 6000;
/** After a refusal the server is not asked again for this long. */
const coolOffMs = 10 * 60_000;

let coolOffUntil = 0;

const responseSchema = z.object({
  data: z
    .object({
      search: z.object({
        groups: z.array(
          z.object({
            documents: z.array(
              z.object({
                object: z.object({
                  __typename: z.string(),
                  // Afisha answers `text: null` for some events (19.10); the page takes it as no date.
                  datePreview: z
                    .object({ text: z.string().nullish() })
                    .nullish(),
                  id: z.string().optional(),
                  minPrice: z.object({ value: z.number() }).nullish(),
                  placeTitle: z.string().nullish(),
                  tickets: z
                    .array(z.object({ saleStatus: z.string().nullish() }))
                    .nullish(),
                  title: z.string().optional(),
                  type: z.object({ name: z.string() }).nullish(),
                  url: z.string().optional(),
                }),
              })
            ),
            title: z.string().nullish(),
          })
        ),
      }),
    })
    .nullish(),
});

const listingResponseSchema = z.object({
  data: z
    .object({
      actualEvents: z.object({
        items: z.array(
          z.object({
            event: z.object({
              id: z.string(),
              tickets: z
                .array(
                  z.object({
                    minPrice: z.object({ value: z.number() }).nullish(),
                    saleStatus: z.string().nullish(),
                  })
                )
                .nullish(),
              title: z.string().nullish(),
              type: z.object({ name: z.string() }).nullish(),
              url: z.string(),
            }),
            scheduleInfo: z
              .object({
                placePreview: z.string().nullish(),
                preview: z.object({ text: z.string().nullish() }).nullish(),
              })
              .nullish(),
          })
        ),
      }),
    })
    .nullish(),
});

type SearchArgs = z.output<typeof afishaSearchOperation.args>;

const dayMs = 86_400_000;

/** A day as written, or nothing for a text that is no day (2026-02-30). */
function dayStamp(text: string) {
  const stamp = Date.parse(text);
  return Number.isNaN(stamp) ||
    new Date(stamp).toISOString().slice(0, 10) !== text
    ? undefined
    : stamp;
}

/**
 * What the listing is asked with, the same as the page's function works it
 * out: Afisha takes the first day and how many days, the person's «from» and
 * «to» are both ends. `undefined` is days that make no sense.
 */
function listingVariables(args: SearchArgs) {
  let dates: { date: string; period: number } | null = null;
  if (args.from || args.to) {
    const first = dayStamp(args.from);
    const last = args.to ? dayStamp(args.to) : first;
    if (first === undefined || last === undefined || last < first) {
      return undefined;
    }
    dates = {
      date: args.from,
      period: Math.min(Math.round((last - first) / dayMs) + 1, 366),
    };
  }
  return {
    dates,
    paging: { limit: args.limit, offset: 0 },
    search: args.query || null,
    tags: args.category ? [args.category] : null,
  };
}

/**
 * A public request to Afisha's GraphQL as the server sends it: no cookie, no
 * redirect followed, the same wait as the call.
 */
function afishaPost(
  city: string,
  operationName: string,
  query: string,
  variables: JsonValue
) {
  return fetch(
    `https://afisha.yandex.ru/api/graphql?city=${encodeURIComponent(city)}&version=604.1.0&query_name=${operationName}`,
    {
      body: JSON.stringify({ operationName, query, variables }),
      headers: {
        "content-type": "application/json",
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "x-force-cors-preflight": "1",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(directBudgetMs),
    }
  );
}

/**
 * The page's public search request as the server sends it. The operator's
 * probe (`ops/yandex-probe.ts`) sends this very request to see how Afisha
 * answers the server's address.
 */
export async function afishaSearchRequest(args: {
  city: string;
  limit: number;
  query: string;
}) {
  return afishaPost(args.city, "BroSearch", afishaSearchGraphql, {
    docs: args.limit,
    text: args.query,
  });
}

/**
 * What an answer says, once it is read: a refusal of the server (blocked,
 * throttled, a captcha page instead of JSON, a timeout) throws and leaves it
 * alone for a while; an answer that is only not what this request needed (a
 * city it does not know) is this call's fault and leaves the direct way
 * open for the others.
 */
async function answerOf<Schema extends z.ZodType>(
  response: Response,
  schema: Schema
) {
  if (
    response.status === 403 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    throw new Error("refused");
  }
  if (response.status !== 200) return undefined;
  const body = schema.safeParse(await response.json());
  return body.success ? body.data : undefined;
}

/** A kind of event or days (or nothing at all) is asked of the listing, words alone of the search. */
function asksListing(args: SearchArgs) {
  return Boolean(args.category || args.from || args.to || !args.query);
}

async function searchDirect(args: SearchArgs): Promise<JsonValue | undefined> {
  const body = await answerOf(await afishaSearchRequest(args), responseSchema);
  if (!body?.data) return undefined;
  const events = body.data.search.groups.flatMap((group) =>
    group.documents.flatMap(
      ({ object: { __typename: typename, ...object } }) =>
        typename === "SearchObjectEvent" &&
        object.id !== undefined &&
        object.title !== undefined &&
        object.url !== undefined
          ? [
              {
                id: object.id,
                kind: object.type?.name ?? group.title ?? null,
                minPrice: object.minPrice ? object.minPrice.value / 100 : null,
                sale: object.tickets?.[0]?.saleStatus ?? null,
                title: object.title,
                url: `https://afisha.yandex.ru${object.url}`,
                venue: object.placeTitle ?? null,
                when: object.datePreview?.text ?? null,
              },
            ]
          : []
    )
  );
  return { events: events.slice(0, args.limit) };
}

/** The events of the listing for these days and words, or nothing when Afisha did not answer as needed. */
async function listedEvents(
  args: SearchArgs,
  variables: Exclude<ReturnType<typeof listingVariables>, undefined>
) {
  const body = await answerOf(
    await afishaPost(args.city, "BroListing", afishaListingGraphql, variables),
    listingResponseSchema
  );
  if (!body?.data) return undefined;
  return body.data.actualEvents.items
    .flatMap(({ event: item, scheduleInfo }) => {
      const ticket = item.tickets?.[0];
      return item.title
        ? [
            {
              id: item.id,
              kind: item.type?.name ?? null,
              minPrice: ticket?.minPrice ? ticket.minPrice.value / 100 : null,
              sale: ticket?.saleStatus ?? null,
              title: item.title,
              url: `https://afisha.yandex.ru${item.url}`,
              venue: scheduleInfo?.placePreview ?? null,
              when: scheduleInfo?.preview?.text ?? null,
            },
          ]
        : [];
    })
    .slice(0, args.limit);
}

async function listingDirect(args: SearchArgs): Promise<JsonValue | undefined> {
  const variables = listingVariables(args);
  if (variables === undefined) return { error: "bad_dates" };
  const events = await listedEvents(args, variables);
  if (events === undefined) return undefined;
  if (events.length === 0 && variables.search !== null) {
    // The words match titles only. Nothing has them (a model puts the kind of
    // event there): once more without them, and the answer says so.
    const shown = await listedEvents(args, { ...variables, search: null });
    if (shown?.length) {
      return { events: shown, queryDropped: variables.search };
    }
  }
  return { events };
}

/**
 * Afisha search with no browser: the same public GraphQL request the page
 * makes, asked from the server. It needs no sign-in, so no cookie is sent.
 * Any refusal (a captcha page, an error, a slow answer, an answer of another
 * shape) answers `undefined`, and the caller asks the pool tab as before;
 * after one the server is left alone for ten minutes, so a blocked address
 * costs a call once, not every time.
 */
export async function afishaSearchDirect(
  rawArgs: JsonValue
): Promise<JsonValue | undefined> {
  if (Date.now() < coolOffUntil) return undefined;
  const parsed = afishaSearchOperation.args.safeParse(rawArgs);
  if (!parsed.success) return undefined;
  try {
    return asksListing(parsed.data)
      ? await listingDirect(parsed.data)
      : await searchDirect(parsed.data);
  } catch {
    coolOffUntil = Date.now() + coolOffMs;
    return undefined;
  }
}
