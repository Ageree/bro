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
// `$` for a Nuxt state's own keys (chitai-gorod.ru's `$sproducts-list`).
const keyPattern = /^[A-Za-z0-9_.$\-[\]]{1,40}$/u;
// A key that is itself a value: a run of four digits, eight hex digits, a uuid.
const valueKey = /\d{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-/iu;
const hostPattern = /^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/u;
// A part of an address's path kept as it is: a short word of lower-case
// latin letters and hyphens (`search`, `vacancy`, `kazan`), or a page's file
// name (wildberries.ru's `detail.aspx`). A percent-encoded word, a phone
// with dashes (916-123-45-67), a user name (ivan_petrov), a number: none of
// them is, they are a person's or an errand's values. A request's own path
// may also have its API version (v2).
const literalSegment =
  /^(?:[a-z-]{1,24}(?:\.(?:html?|shtml|php|aspx?|jsp|cgi))?)?$/u;
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

const indexSchema = z.number().int().min(0).max(1000);

/**
 * A word of the site's own data a step names (the field's value that tells
 * an element of a list from the others, a key's stable start): latin, no
 * value in it. The worker drops an operation whose step is a word of its
 * page's own address — the errand's —, which the schema cannot know.
 */
const dataWord = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{1,39}$/u)
  .refine((word) => !valueKey.test(word), "a word, not a value");

/** A path from the data's root to a table: its keys, never an id looked up in it. */
const tablePathSchema = z
  .array(z.union([plainKey, indexSchema]))
  .min(1)
  .max(8);

/**
 * One step of a path into the data (`site_values` in
 * browser-vm/worker/worker.py): a key, an index, `"*"` (every element of a
 * list or value of a table there — a price read so is the least of them),
 * or: `json` (the value is a string of JSON: ozon.ru's widget states),
 * `prefix` (the first key that starts so, the rest of it a value),
 * `with` (the element of a list whose field is the word: ozon.ru's atoms),
 * `deep` (the first value under the key anywhere below: a Next.js flight's
 * rows) and `at` (the value is an id: go on in that table's entry, the
 * table by its path from the data's root: kupibilet.ru's flights).
 */
const joinSchema = z.strictObject({ at: tablePathSchema });

/** A step that is more than a key or an index: what only a worker from 26.10 walks. */
const wideStepSchema = z.union([
  z.literal("*"),
  joinSchema,
  z.strictObject({ json: z.literal(true) }),
  z.strictObject({
    prefix: dataWord.refine(
      (prefix) => /[-_:]$/u.test(prefix),
      "a key's start, up to a separator"
    ),
  }),
  z.strictObject({
    with: z.tuple([
      z.enum([
        "id",
        "key",
        "type",
        "name",
        "kind",
        "code",
        "component",
        "widget",
      ]),
      dataWord,
    ]),
  }),
  z.strictObject({ deep: plainKey }),
]);

const stepSchema = z.union([plainKey, indexSchema, wideStepSchema]);

function isJoin(step: z.infer<typeof stepSchema>) {
  return joinSchema.safeParse(step).success;
}

const fieldPathSchema = z
  .array(stepSchema)
  .max(12)
  .refine((path) => path.filter(isJoin).length <= 3, "at most three joins");

/** Where the results are: a list, or with `"*"` as its last step a table's values (tutu.ru's offers). */
const itemsSchema = fieldPathSchema.refine(
  (path) =>
    path.every(
      (step, index) =>
        (step !== "*" || index === path.length - 1) && !isJoin(step)
    ),
  "a list's path: a table's values only last, no join"
);

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
        .regex(/^\/[a-z\-/{}0-9.]*$/u),
    })
    .refine(
      ({ parts, template }) =>
        pathTemplate(template.replaceAll(/\{\d\}/gu, ""), false) &&
        parts.every((_, index) => template.includes(`{${String(index)}}`)),
      "a link template: the element's fields, never a value"
    ),
]);

/**
 * A global a page's script assigns its state to (`window.initialState =
 * {…}`, `X = JSON.parse("…")`), written dotted: a name the page keeps across
 * its builds — four characters at least, not a minifier's local — and up to
 * three properties (`_cianConfig.frontend-serp`).
 */
const assignmentName = z
  .string()
  .max(80)
  .regex(/^[A-Za-z_$][\w$]{3,40}(?:\.[\w$-]{1,40}){0,3}$/u)
  .refine(
    (name) => name.split(".").every((part) => !valueKey.test(part)),
    "a name, not a value"
  );

const attributeName = z.string().regex(/^data-[a-z][a-z0-9-]{0,30}$/u);

/**
 * Where a results document keeps its state (`embedded_states` in
 * browser-vm/worker/worker.py): a script or template that is JSON whole —
 * by its id, or its type and place; a Nuxt 3 payload unflattened —, a
 * script's assignment, JSON in an element's data-* attribute (the element
 * by its id, the stable start of an id whose rest is a value, or its place)
 * or a Next.js flight's rows.
 */
const stateSchema = z.union([
  z.strictObject({
    decode: z.literal("devalue").optional(),
    id: plainKey,
    tag: z.enum(["script", "template"]),
  }),
  z.strictObject({
    index: z.number().int().min(0).max(50),
    tag: z.enum(["script", "template"]),
    type: z.enum(["application/json", "application/ld+json", ""]),
  }),
  z.strictObject({ assignment: assignmentName }),
  z.strictObject({
    attribute: attributeName,
    idPrefix: dataWord.refine(
      (prefix) => /[-_:]$/u.test(prefix),
      "an id's start, up to a separator"
    ),
  }),
  z.strictObject({ attribute: attributeName, id: plainKey }),
  z.strictObject({
    attribute: attributeName,
    index: z.number().int().min(0).max(200),
  }),
  z.strictObject({ flight: z.literal("next") }),
]);

/**
 * A class a site wrote by hand (`product-card__name`, `tile-root`), not one
 * its build generated: no token with a digit but a short number after a word
 * (`col-6`) or `h1`–`h6`, no camelCase part of four letters or more without
 * a vowel (styled-components' `knfjIn`), no token of two one-letter parts or
 * more (`iNXzHE`). As `site_class_ok` in browser-vm/worker/worker.py; its
 * learner also leaves out a page's families of short generated classes
 * (tutu.ru's `eibe`, `dube`), which a selector alone does not show.
 */
function handWritten(name: string) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,59}$/u.test(name)) return false;
  const tokens = name.split(/[-_]+/u).filter((token) => token !== "");
  return (
    tokens.length > 0 &&
    tokens.every((token, index) => {
      if (
        /\d/u.test(token) &&
        !(/^\d{1,2}$/u.test(token) && index > 0) &&
        !/^h[1-6]$/u.test(token)
      ) {
        return false;
      }
      const parts = token.split(/(?=[A-Z])/u);
      if (
        parts.filter((part) => part.length === 1).length >= 2 &&
        token !== token.toUpperCase()
      ) {
        return false;
      }
      return parts.every(
        (part) =>
          part.replaceAll(/\d/gu, "").length < 4 || /[aeiouy]/iu.test(part)
      );
    })
  );
}

// Attributes whose value a site writes as its own word for a role: test
// hooks, component names, schema.org. Any other is named by presence only.
const roleAttributes = new Set([
  "data-testid",
  "data-test-id",
  "data-test",
  "data-qa",
  "data-qa-id",
  "data-marker",
  "data-e2e",
  "data-cy",
  "data-auto",
  "data-zone-name",
  "data-widget",
  "data-ti",
  "data-name",
  "data-mark",
  "data-slot",
  "data-component",
  "data-role",
  "data-block",
  "itemprop",
  "itemtype",
  "role",
]);

const selectorAttribute = String.raw`\[(?:[a-z][a-z-]{1,40}|[a-z][a-z-]{1,40}="(?:[A-Za-z][A-Za-z_-]{1,39}|https?://schema\.org/[A-Za-z]{1,40})"|href\*="/[a-z-]{2,24}/")\]`;
const selectorSimple = String.raw`(?::scope|[a-z][a-z0-9]{0,15})(?:\.[A-Za-z][A-Za-z0-9_-]{1,59})*(?:${selectorAttribute})*`;
const simplePattern = new RegExp(`^${selectorSimple}$`, "u");
const hasPattern = new RegExp(
  `^(${selectorSimple}):has\\(> (${selectorSimple}(?: > ${selectorSimple}){0,3})\\)$`,
  "u"
);

function simpleSelectorOk(part: string) {
  if (!simplePattern.test(part)) return false;
  const classes = [
    ...part
      .replaceAll(/\[[^\]]*\]/gu, "")
      .matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/gu),
  ].map((match) => match[1] ?? "");
  if (!classes.every(handWritten)) return false;
  return [...part.matchAll(/\[([a-z-]+)="([^"]*)"\]/gu)].every(
    ([, name = "", value = ""]) =>
      roleAttributes.has(name) &&
      (value.startsWith("http") || handWritten(value))
  );
}

/**
 * A CSS selector of the site's own words (`site_selector_ok` in
 * browser-vm/worker/worker.py): up to six compounds joined by " " or " > ";
 * a compound is a tag (or `:scope`, first only), hand-written classes,
 * attributes and at most one `:has(> …)`. An attribute is named by its
 * presence, or with a value only as a role attribute whose value is a latin
 * code word, or as a link's `href*="/word/"`. No other quote, no digit run,
 * no letter of another alphabet: an errand's value cannot be written in it.
 * The worker also drops an operation whose selector holds a latin word of
 * its page's own address (the errand's), which the schema cannot know.
 */
function selectorOk(selector: string) {
  if (selector.length > 200 || selector !== selector.trim()) return false;
  const tokens = selector.split(/ (?![^()]*\))/u);
  const parts = tokens.filter((token) => token !== ">");
  if (
    parts.length < 1 ||
    parts.length > 6 ||
    tokens.includes("") ||
    tokens[0] === ">" ||
    tokens.at(-1) === ">" ||
    tokens.some((token, index) => token === ">" && tokens[index + 1] === ">")
  ) {
    return false;
  }
  return parts.every((part, index) => {
    const has = hasPattern.exec(part);
    const pieces = has
      ? [has[1] ?? "", ...(has[2] ?? "").split(" > ")]
      : [part];
    return (
      pieces.every(simpleSelectorOk) &&
      !pieces.slice(1).some((piece) => piece.startsWith(":scope")) &&
      !(index > 0 && part.startsWith(":scope"))
    );
  });
}

const selectorSchema = z
  .string()
  .max(200)
  .refine(selectorOk, "a selector of the site's own words, never a value");

const cellSchema = z.strictObject({
  attribute: z
    .union([
      z.enum(["href", "title", "aria-label", "alt", "content"]),
      z.string().regex(/^data-[a-z][a-z-]{1,30}$/u),
    ])
    .optional(),
  selector: selectorSchema,
});

/**
 * Results that are rows of the page's HTML (Pomerado's `readRows`,
 * `site_op_rows` in browser-vm/worker/worker.py): the rows' selector and
 * each field's selector inside a row, its text or an attribute. `render:
 * false` reads the document fetched from a tab on the site; `true`, the
 * page drawn with its pictures and fonts left out. `twins`: the page keeps
 * a hidden copy of each row (kupibilet.ru's mobile tickets), and a row its
 * name does not name is dropped. Its data is a list of `{name, price, link,
 * text}`, so its `items` are [] and its fields those keys.
 */
const htmlSourceSchema = z.strictObject({
  cells: z.strictObject({
    link: cellSchema.optional(),
    name: cellSchema,
    price: cellSchema.optional(),
  }),
  kind: z.literal("html"),
  render: z.boolean(),
  rows: selectorSchema,
  twins: z.literal(true).optional(),
});

const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("document"),
    state: stateSchema,
  }),
  z.strictObject({
    kind: z.literal("xhr"),
    method: z.enum(["GET", "POST"]),
    url: templateSchema(true).refine(
      (address) => splitAddress(address)?.query === undefined,
      "the request's address, no query"
    ),
  }),
  htmlSourceSchema,
]);

// A site's own token for its order (`price`, `priceup`, `price.asc`, `1`):
// a word of its addresses, never a person's value.
const inputToken = /^[A-Za-z0-9_.-]{1,24}$/u;

/** The query pairs that make the site sort its results (`sorting=price`, `order=price&way=forward`). */
const sortPairsSchema = z
  .string()
  .max(80)
  .refine(
    (pairs) =>
      pairs.split("&").every((pair) => {
        const [key = "", value = "", ...rest] = pair.split("=");
        return (
          rest.length === 0 &&
          plainKey.safeParse(key).success &&
          inputToken.test(value)
        );
      }),
    "the site's own keys and tokens"
  );

/**
 * What the site itself applies to its results beyond the template's page
 * (Pomerado's typed inputs, set the way the site's own controls set them):
 * the pairs that sort them by price, the keys that bound their price, and
 * the key of their page. A reviewed operation's (`knownSiteOperations`)
 * were each read back live on the stand; a find learns the sort and the
 * price bounds from a run's results page that came in order of price or
 * within the bounds it was asked with (`site_learned_inputs` in
 * browser-vm/worker/worker.py). Bro reads the order back on every read
 * (`site-ops/inputs.ts`), and the worker keeps only the cards within the
 * bounds an errand names.
 */
const siteInputsSchema = z.strictObject({
  /** The page of the results: `first` is the number of the first one (0 on hh.ru). */
  page: z
    .strictObject({
      first: z.union([z.literal(0), z.literal(1)]),
      key: plainKey,
    })
    .optional(),
  /**
   * A price bound in roubles: the site's key for each end, or one key for
   * both as `<min>;<max>` (ozon.ru's `1500.000;3000.000`, wildberries.ru's
   * kopecks).
   */
  price: z
    .union([
      z.strictObject({ max: plainKey.optional(), min: plainKey.optional() }),
      z.strictObject({
        decimals: z.union([z.literal(0), z.literal(3)]),
        range: plainKey,
        unit: z.enum(["rub", "kop"]),
      }),
    ])
    .optional(),
  /** The pairs that sort the results by price: cheapest first, dearest first. */
  sort: z
    .strictObject({
      asc: sortPairsSchema.optional(),
      desc: sortPairsSchema.optional(),
    })
    .optional(),
});

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
      /** The price is in hundredths of the currency (kopecks: tutu.ru, wildberries.ru, youla.ru). */
      cents: z.literal(true).optional(),
      link: linkSchema.optional(),
      name: fieldPathSchema.min(1).optional(),
      price: fieldPathSchema.min(1).optional(),
    }),
    /** What the site applies beyond the page: a find's are its sort and price bounds. */
    inputs: siteInputsSchema.optional(),
    items: itemsSchema,
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
    // The site's own API host counts: one under the page's host (api.litres.ru
    // for www.litres.ru, offers-api.tutu.ru for www.tutu.ru), never another site.
    const request = splitAddress(operation.source.url)?.host ?? "";
    return sameSiteHost(request, siteOperationHost(operation.page));
  }, "the page's own site answers it")
  // An html operation's data is its rows as `{name, price, link, text}`,
  // read as they are: its items are [] and its fields those keys.
  .refine(
    ({ fields, items, source }) =>
      source.kind !== "html" ||
      (items.length === 0 &&
        same(fields.name, ["name"]) &&
        (fields.price === undefined || same(fields.price, ["price"])) &&
        (fields.link === undefined ||
          fields.link === "page" ||
          same(fields.link, { path: ["link"] }))),
    "an html operation reads its rows' own cells"
  );

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

/**
 * The worker an operation needs to be read right (`site_values` and
 * `embedded_states` in browser-vm/worker/worker.py): one from 26.10 when its
 * state is kept anywhere but a script or template that is JSON whole, a step
 * of a path is more than a key or an index, or its price is in hundredths.
 * An older worker reads no such state or step and answers `no_data`, which
 * would count against a sound operation; it reads a price in hundredths as
 * roubles; one from 26.10 again (`.2`) for an html operation, which an
 * older worker does not read at all, and (`.3`) for a page whose path holds
 * a search's words (`%query%`), which an older one refuses. Undefined when
 * any worker reads it.
 */
export function siteOperationWorker(operation: SiteOperation) {
  const { fields, items, source } = operation;
  const pages = [operation.page, ...("url" in source ? [source.url] : [])];
  if (pages.some((page) => splitAddress(page)?.path.includes("%query%"))) {
    return pathQueryWorker;
  }
  if (source.kind === "html") return rowsReadingWorker;
  const link = fields.link === "page" ? undefined : fields.link;
  const paths = [
    items,
    fields.name ?? [],
    fields.price ?? [],
    ...(link === undefined ? [] : "path" in link ? [link.path] : link.parts),
  ];
  const state =
    source.kind === "document" &&
    !("tag" in source.state && !("decode" in source.state));
  const steps = paths.some((path) =>
    path.some((step) => wideStepSchema.safeParse(step).success)
  );
  return state || steps || fields.cents === true
    ? stateReadingWorker
    : undefined;
}

const stateReadingWorker = "2026-10-26.1";
// The worker that reads a page's rows (`site_op_rows`): an older one leaves
// an html operation out of a run's operations and refuses it in /v1/op.
const rowsReadingWorker = "2026-10-26.2";
// The worker that fills a `%query%` part of a path with words and spaces
// (`site_template_fit`): an older one refuses such a page in /v1/op.
const pathQueryWorker = "2026-10-26.3";

export function siteOperationHost(page: string) {
  return splitAddress(page)?.host ?? "";
}

/**
 * Whether two hosts are one site: the same host, a leading `www.` aside, or
 * one under the other — the site's city or section on a subdomain of its
 * own (`blagoveschensk.hh.ru` for `hh.ru`, `auto.drom.ru` for `drom.ru`),
 * as the worker's `site_same_place` reads a page that went there. Never two
 * hosts beside each other: under .msk.ru or .co.uk those are a registry's.
 */
export function sameSiteHost(a: string, b: string) {
  const one = siteOf(a);
  const two = siteOf(b);
  return (
    one !== "" &&
    two !== "" &&
    (one === two || one.endsWith(`.${two}`) || two.endsWith(`.${one}`))
  );
}

/**
 * Whether an operation's page is on the site (`https://www.tutu.ru` for
 * `tutu.ru`, `https://hh.ru` for `blagoveschensk.hh.ru`): an errand names
 * the site, and the run that found the operation may have ended on its
 * city's host.
 */
export function siteOperationOnSite(operation: SiteOperation, site: string) {
  const host = URL.parse(site)?.hostname;
  return (
    host !== undefined && sameSiteHost(host, siteOperationHost(operation.page))
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
    inputs: mergeSiteInputs(kept.inputs, found.inputs),
    name: siteOperationName(page),
    page,
  }).data;
}

type SiteInputs = z.infer<typeof siteInputsSchema>;

/**
 * What a site applies, as two operations of one page know it: the newer's
 * where it has one, the older's otherwise. A find learns the sort only from
 * a run that sorted by price (`site_learned_inputs`), so a later run that
 * did not would otherwise lose it.
 */
export function mergeSiteInputs(
  older: SiteInputs | undefined,
  newer: SiteInputs | undefined
): SiteInputs | undefined {
  if (older === undefined || newer === undefined) return newer ?? older;
  const merged: SiteInputs = {};
  const page = newer.page ?? older.page;
  if (page !== undefined) merged.page = page;
  const price = newer.price ?? older.price;
  if (price !== undefined) merged.price = price;
  if (older.sort !== undefined || newer.sort !== undefined) {
    merged.sort = { ...older.sort, ...newer.sort };
  }
  return merged;
}

// A part of an address's path that a `loose` page may hold where its template
// has a word (`site_template_fit` in browser-vm/worker/worker.py, SITE_LOOSE_PART).
const loosePart = /^[\p{L}\p{N}_.-]{1,60}$/u;
// What a `%query%` part of a path holds: a search's words, spaces between
// them (labirint.ru's /search/анна каренина/; SITE_QUERY_PART in the worker).
const queryPart = /^[\p{L}\p{N}_\-.,'"«»+:!?&() ]{1,120}$/u;

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
    if (
      part === "" ||
      value === undefined ||
      !(part === "%query%" ? queryPart : loosePart).test(value)
    ) {
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
