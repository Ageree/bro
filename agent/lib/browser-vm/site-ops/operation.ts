import * as z from "zod";

/**
 * A site's read operation as the worker finds it behind a run's reported
 * options (`site_operations` in browser-vm/worker/worker.py) and as its
 * code engine replays it (`op(name, url)`): the results page as a template,
 * where the page's results come from, and where the options are in them.
 *
 * Nothing of a run's values is in it, and the schema is what makes sure of
 * that before anything is kept: the page's query is only its keys, each
 * with a typed placeholder; a part of an address's path is either a short
 * word of lower-case latin letters and hyphens or a placeholder; a key of
 * the data that looks like a value (an id, a hash, a uuid) is refused; there
 * is no request body, no header and no cookie, and any key the schema does
 * not name refuses the whole record. The worker writes its templates by the
 * same rules (`site_path_part`, `site_key` in browser-vm/worker/worker.py);
 * the schema refuses, it never cleans.
 */
const placeholder = /^%(?:query|number|date|sort|flag|id|word)%$/u;
const keyPattern = /^[A-Za-z0-9_.\-[\]]{1,40}$/u;
// A key that is itself a value: a run of four digits, eight hex digits, a uuid.
const valueKey = /\d{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-/iu;
const hostPattern = /^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/u;
// A part of an address's path kept as it is: a short word of lower-case
// latin letters and hyphens (`search`, `vacancy`, `kazan`). A
// percent-encoded word, a phone with dashes (916-123-45-67), a user name
// (ivan_petrov), a number: none of them is, they are a person's or an
// errand's values. A request's own path may also have its API version (v2).
const literalSegment = /^[a-z-]{0,24}$/u;
const apiVersion = /^v\d{1,2}$/u;

const plainKey = z
  .string()
  .regex(keyPattern)
  .refine((key) => !valueKey.test(key), "a key, not a value");

function pathTemplate(path: string, request: boolean) {
  return path
    .split("/")
    .every(
      (segment) =>
        placeholder.test(segment) ||
        literalSegment.test(segment) ||
        (request && apiVersion.test(segment))
    );
}

/** `https://host/path` and the query after `?`, read without decoding a placeholder. */
function splitAddress(address: string) {
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/u.exec(address);
  if (match === null) return undefined;
  const [, host = "", path = "/", query] = match;
  return { host, path, query };
}

/**
 * A host as one site: the exact host, a leading `www.` aside. Not its last
 * two labels: under .msk.ru or .co.uk those are a registry's.
 */
function siteOf(host: string) {
  return host.toLowerCase().replace(/^www\./u, "");
}

function templateSchema(request: boolean) {
  return z
    .string()
    .max(600)
    .refine((address) => {
      const parts = splitAddress(address);
      if (parts === undefined || !hostPattern.test(parts.host)) return false;
      if (!pathTemplate(parts.path, request)) return false;
      if (parts.query === undefined) return true;
      const keys = parts.query.split("&").map((pair) => pair.split("="));
      return (
        keys.length <= 20 &&
        keys.every(
          ([key = "", value, ...rest]) =>
            rest.length === 0 &&
            plainKey.safeParse(key).success &&
            value !== undefined &&
            placeholder.test(value)
        )
      );
    }, "a results page as a template: placeholders for every value");
}

const fieldPathSchema = z
  .array(z.union([plainKey, z.number().int().min(0).max(1000)]))
  .max(12);

const linkSchema = z.union([
  z.literal("page"),
  z.strictObject({ path: fieldPathSchema.min(1) }),
  z
    .strictObject({
      parts: z.array(fieldPathSchema.min(1)).min(1).max(6),
      query: z.array(plainKey).max(10),
      template: z
        .string()
        .max(300)
        .regex(/^\/[a-z\-/{}0-9]*$/u),
    })
    .refine(
      ({ parts, template }) =>
        pathTemplate(template.replaceAll(/\{\d\}/gu, ""), false) &&
        parts.every((_, index) => template.includes(`{${String(index)}}`)),
      "a link template: the element's fields, never a value"
    ),
]);

const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("document"),
    state: z.union([
      z.strictObject({
        id: plainKey,
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
    url: templateSchema(true).refine(
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
    page: templateSchema(false),
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

/**
 * Why a read of a site by one of its operations gave no results
 * (`SiteOpFailure` in browser-vm/worker/worker.py): `blocked` — the site
 * turned the browser away; `moved` — the page answered from another
 * address or not at all; `no_data` — the results are no longer where the
 * operation reads them; `empty` — none for this page; `unanswered` — its
 * results name none of the words asked (`site_op_answers`); `failed` —
 * anything else (the network, a timeout).
 */
export const siteReadFailures = [
  "blocked",
  "moved",
  "no_data",
  "empty",
  "unanswered",
  "failed",
] as const;

export type SiteReadFailure = (typeof siteReadFailures)[number];

/**
 * How a run's op() calls went (`SiteTraffic.op_calls`): `fit` is how its
 * page fitted the template (`loose` when only literal words of its path
 * differed). A malformed call is dropped, not the run.
 */
export const siteOperationCallsSchema = z
  .array(
    z
      .object({
        fit: z.enum(["exact", "loose"]),
        name: z.string().min(1).max(160),
        ok: z.boolean(),
        reason: z.enum(siteReadFailures).optional(),
      })
      .nullable()
      .catch(null)
  )
  .max(20)
  .transform((calls) => calls.filter((call) => call !== null));

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

// A part of an address's path that a `loose` page may hold where its template
// has a word (`site_template_fit` in browser-vm/worker/worker.py, SITE_LOOSE_PART).
const loosePart = /^[\p{L}\p{N}_.-]{1,60}$/u;

/**
 * How an address fits an operation's results page, as the worker decides it
 * (`site_template_fit`): `exact` when its host and path are the template's,
 * a placeholder standing for any one part; `loose` when the only parts that
 * differ are words the template kept as they were, which one find cannot
 * tell from the errand's own values (the city of /hotel/russia/kazan/). Its
 * query may hold only the template's keys. Undefined otherwise.
 */
export function siteReadFit(operation: SiteOperation, address: string) {
  const template = splitAddress(operation.page);
  const url = URL.parse(address);
  if (template === undefined || url?.protocol !== "https:") return undefined;
  if (url.host !== template.host || url.username || url.password) {
    return undefined;
  }
  // A placeholder left as it is (`%word%`) is no page of the site's.
  if (/%(?:query|number|date|sort|flag|id|word)%/u.test(address)) {
    return undefined;
  }
  const keys = new Set(
    (template.query ?? "").split("&").map((pair) => pair.split("=")[0])
  );
  if ([...url.searchParams.keys()].some((key) => !keys.has(key))) {
    return undefined;
  }
  const wanted = template.path.replace(/\/$/u, "").split("/");
  const given = url.pathname.replace(/\/$/u, "").split("/");
  if (wanted.length !== given.length) return undefined;
  let fit: "exact" | "loose" = "exact";
  for (const [index, part] of wanted.entries()) {
    const value = decodeURIComponentSafe(given[index] ?? "");
    const filled = placeholder.test(part);
    if (!filled && decodeURIComponentSafe(part) === value) continue;
    // A placeholder's value is one part of a path all the same: no slash.
    if (part === "" || value === undefined || !loosePart.test(value)) {
      return undefined;
    }
    if (!filled) fit = "loose";
  }
  return fit;
}

/**
 * An address with only the query keys its operation's page has: a key the
 * fill added (auto.ru's `sort` on the stand, 25.10) is left out rather than
 * the read, since the page is the template's either way.
 */
export function withTemplateKeys(operation: SiteOperation, address: string) {
  const template = splitAddress(operation.page);
  const url = URL.parse(address);
  if (template === undefined || url === null) return address;
  const keys = new Set(
    (template.query ?? "").split("&").map((pair) => pair.split("=")[0])
  );
  url.search = new URLSearchParams(
    [...url.searchParams].filter(([key]) => keys.has(key))
  ).toString();
  return url.href;
}

function decodeURIComponentSafe(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/**
 * An operation whose page read a `loose` address as broader: each word of
 * its path the address held otherwise is a placeholder now
 * (`/toyota/camry/` and `/kia/rio/` are `/%word%/%word%/`), as two finds
 * would make it (`mergeSiteOperations`). Undefined when the schema refuses it.
 */
export function widenedSiteOperation(
  operation: SiteOperation,
  address: string
): SiteOperation | undefined {
  const template = splitAddress(operation.page);
  const url = URL.parse(address);
  if (template === undefined || url === null) return undefined;
  const given = url.pathname.split("/");
  const path = template.path
    .split("/")
    .map((part, index) =>
      placeholder.test(part) ||
      decodeURIComponentSafe(part) ===
        decodeURIComponentSafe(given[index] ?? "")
        ? part
        : "%word%"
    )
    .join("/");
  const page = `https://${template.host}${path}${template.query === undefined ? "" : `?${template.query}`}`;
  return siteOperationSchema.safeParse({
    ...operation,
    name: siteOperationName(page),
    page,
  }).data;
}
