import { z } from "zod";
import type { JsonValue } from "../operations";
import { afishaSearchGraphql, afishaSearchOperation } from "./search";

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
                  datePreview: z.object({ text: z.string() }).nullish(),
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
  const args = parsed.data;
  try {
    const response = await fetch(
      `https://afisha.yandex.ru/api/graphql?city=${encodeURIComponent(args.city)}&version=604.1.0&query_name=BroSearch`,
      {
        body: JSON.stringify({
          operationName: "BroSearch",
          query: afishaSearchGraphql,
          variables: { docs: args.limit, text: args.query },
        }),
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
    const body = responseSchema.safeParse(
      response.status === 200 ? await response.json() : undefined
    );
    if (!body.success || !body.data.data) throw new Error("refused");
    const events = body.data.data.search.groups.flatMap((group) =>
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
                  minPrice: object.minPrice
                    ? object.minPrice.value / 100
                    : null,
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
  } catch {
    coolOffUntil = Date.now() + coolOffMs;
    return undefined;
  }
}
