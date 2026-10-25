import * as z from "zod";

/**
 * A site's read operation as the worker finds it behind a run's reported
 * options (`site_operations` in browser-vm/worker/worker.py) and as its
 * code engine replays it (`op(name, url)`): the results page as a template,
 * where the page's results come from, and where the options are in them.
 *
 * Nothing of a run's values is in it, and the schema is what makes sure of
 * that before anything is kept: the page's query is only its keys, each
 * with a typed placeholder; a part of an address that looks like an id, a
 * number or an email is a placeholder too; there is no request body, no
 * header and no cookie, and any key the schema does not name refuses the
 * whole record.
 */
const placeholder = /^%(?:query|number|date|sort|flag|id|word)%$/u;
const keyPattern = /^[A-Za-z0-9_.\-[\]]{1,40}$/u;
const hostPattern = /^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/u;
// A literal part of an address: no run of four digits (an id, a phone, a
// date) and no `@` (an email). Percent-encoded words (a city in Cyrillic)
// are letters, not values, and pass.
const literalPattern = /^[A-Za-z0-9\-_.~%]*$/u;
const valueLike = /\d{4,}|@/u;

function literalOrPlaceholder(segment: string) {
  return (
    placeholder.test(segment) ||
    (literalPattern.test(segment) &&
      !valueLike.test(decodeURIComponentSafe(segment)))
  );
}

function decodeURIComponentSafe(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `https://host/path` and the query after `?`, read without decoding a placeholder. */
function splitAddress(address: string) {
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/u.exec(address);
  if (match === null) return undefined;
  const [, host = "", path = "/", query] = match;
  return { host, path, query };
}

function siteOf(host: string) {
  return host.split(".").slice(-2).join(".");
}

const templateSchema = z
  .string()
  .max(600)
  .refine((address) => {
    const parts = splitAddress(address);
    if (parts === undefined || !hostPattern.test(parts.host)) return false;
    if (!parts.path.split("/").every(literalOrPlaceholder)) return false;
    if (parts.query === undefined) return true;
    const keys = parts.query.split("&").map((pair) => pair.split("="));
    return (
      keys.length <= 20 &&
      keys.every(
        ([key = "", value, ...rest]) =>
          rest.length === 0 &&
          keyPattern.test(key) &&
          value !== undefined &&
          placeholder.test(value)
      )
    );
  }, "a results page as a template: placeholders for every value");

const fieldPathSchema = z
  .array(
    z.union([z.string().regex(keyPattern), z.number().int().min(0).max(1000)])
  )
  .max(12);

const linkSchema = z.union([
  z.literal("page"),
  z.strictObject({ path: fieldPathSchema.min(1) }),
  z
    .strictObject({
      parts: z.array(fieldPathSchema.min(1)).min(1).max(6),
      query: z.array(z.string().regex(keyPattern)).max(10),
      template: z
        .string()
        .max(300)
        .regex(/^\/[A-Za-z0-9\-_.~%/{}]*$/u),
    })
    .refine(
      ({ parts, template }) =>
        !valueLike.test(template.replaceAll(/\{\d\}/gu, "")) &&
        parts.every((_, index) => template.includes(`{${String(index)}}`)),
      "a link template: the element's fields, never a value"
    ),
]);

const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("document"),
    state: z.union([
      z.strictObject({
        id: z.string().regex(keyPattern),
        tag: z.enum(["script", "template"]),
      }),
      z.strictObject({
        index: z.number().int().min(0).max(50),
        tag: z.enum(["script", "template"]),
        type: z.enum(["application/json", "application/ld+json", ""]),
      }),
    ]),
  }),
  z.strictObject({
    kind: z.literal("xhr"),
    method: z.enum(["GET", "POST"]),
    url: templateSchema.refine(
      (address) => splitAddress(address)?.query === undefined,
      "the request's address, no query"
    ),
  }),
]);

export const siteOperationSchema = z
  .strictObject({
    /**
     * What a person who reviewed the operation says its fields mean (a price
     * for the whole stay): only the reviewed ones have it
     * (`knownSiteOperations`), a find of a run's never keeps one.
     */
    about: z
      .string()
      .max(300)
      .regex(/^[^\n%{}]*$/u)
      .optional(),
    fields: z.strictObject({
      link: linkSchema.optional(),
      name: fieldPathSchema.min(1).optional(),
      price: fieldPathSchema.min(1).optional(),
    }),
    items: fieldPathSchema,
    name: z.string().min(1).max(160),
    page: templateSchema,
    seen: z.strictObject({
      items: z.number().int().nonnegative(),
      matched: z.number().int().nonnegative(),
      of: z.number().int().nonnegative(),
    }),
    source: sourceSchema,
  })
  .refine(
    (operation) => operation.name === siteOperationName(operation.page),
    "the name is the page's host and path"
  )
  .refine((operation) => {
    if (operation.source.kind !== "xhr") return true;
    const request = splitAddress(operation.source.url)?.host ?? "";
    return siteOf(request) === siteOf(siteOperationHost(operation.page));
  }, "the page's own site answers it");

export type SiteOperation = z.infer<typeof siteOperationSchema>;

/**
 * What a worker's run record says it found (`siteTraffic.operations`):
 * read as plain JSON, each record checked by `siteOperationSchema` before
 * it is kept, so one malformed find does not make the run unreadable.
 */
export const foundSiteOperationsSchema = z.array(z.json()).max(10);

/** An operation's name: its results page's host and path (`hh.ru/search/vacancy`). */
function siteOperationName(page: string) {
  return page.replace(/^https:\/\//u, "").split("?")[0] ?? page;
}

export function siteOperationHost(page: string) {
  return splitAddress(page)?.host ?? "";
}

/** Whether an operation's page is on the site (`https://www.tutu.ru` for `tutu.ru`). */
export function siteOperationOnSite(operation: SiteOperation, site: string) {
  const host = URL.parse(site)?.hostname;
  return (
    host !== undefined &&
    siteOf(host) === siteOf(siteOperationHost(operation.page))
  );
}

function same<T>(a: T, b: T) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Two finds of one operation with different pages, as one: where the two
 * results pages differ in a part of their path, the part is a placeholder
 * (`/hotel/russia/kazan/` and `/hotel/russia/moscow/` are
 * `/hotel/russia/%word%/`). Undefined when they are not one operation: the
 * data comes from elsewhere, or its options sit elsewhere in it.
 */
export function mergeSiteOperations(
  kept: SiteOperation,
  found: SiteOperation
): SiteOperation | undefined {
  const one = splitAddress(kept.page);
  const two = splitAddress(found.page);
  if (
    one === undefined ||
    two === undefined ||
    one.host !== two.host ||
    !same(kept.source, found.source) ||
    !same(kept.items, found.items) ||
    !same(kept.fields, found.fields)
  ) {
    return undefined;
  }
  const keptPath = one.path.split("/");
  const foundPath = two.path.split("/");
  if (keptPath.length !== foundPath.length) return undefined;
  const path = keptPath
    .map((segment, index) =>
      segment === foundPath[index] ? segment : "%word%"
    )
    .join("/");
  const keys = new Set(
    [one.query, two.query]
      .flatMap((query) => (query === undefined ? [] : query.split("&")))
      .filter((pair) => pair !== "")
  );
  const page = `https://${one.host}${path}${keys.size > 0 ? `?${[...keys].join("&")}` : ""}`;
  return siteOperationSchema.safeParse({
    ...found,
    name: siteOperationName(page),
    page,
  }).data;
}
