import * as z from "zod";

/**
 * A card: one screen of structured information Bro sends to a chat as a
 * button that opens a page (a Telegram Mini App). The model does not fill a
 * template per situation; it composes the card from the fixed catalog of
 * blocks below, so any situation fits and the page always looks like Bro.
 * The catalog, the tones and the rules of composition are in `docs/cards.md`.
 */

const shortText = (maximum: number) => z.string().trim().min(1).max(maximum);

const httpsUrl = z.url({ protocol: /^https$/u, hostname: z.regexes.domain });

/** What a button of a card may open: a site, a phone call or an email. */
const actionHref = z.union([
  httpsUrl,
  z.string().regex(/^tel:\+?[0-9]{5,15}$/u),
  z.string().regex(/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/u),
]);

/**
 * How a card or a callout reads at a glance. `neutral` is plain paper; the
 * others tint the header band and the callout with the brand palette.
 */
const cardTones = ["neutral", "info", "success", "warning", "danger"] as const;
const toneSchema = z.enum(cardTones);

const chipColors = ["neutral", "blue", "yellow", "pink", "coral"] as const;
const chipSchema = z.strictObject({
  text: shortText(30),
  color: z.enum(chipColors).default("neutral"),
});

/**
 * A photograph of the thing a row or an option is about: a hotel, a product, a
 * place. The address is where Bro found it; the page never loads it from there
 * (Bro keeps its own copy of every photo, `docs/cards.md`). `credit` names the
 * site it came from.
 */
const photoSchema = z.strictObject({
  url: httpsUrl,
  alt: shortText(120),
  credit: shortText(60).optional(),
});

/**
 * What a card's answer is keyed by: the id of a field or of a button. Lower case
 * latin so that the person's answers reach Bro as plain keys.
 */
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u);

const optionSchema = z.strictObject({
  value: identifier,
  title: shortText(80),
  detail: shortText(120).optional(),
  side: shortText(40).optional(),
  photo: photoSchema.optional(),
});

const place = z.strictObject({
  place: shortText(40),
  time: shortText(16).optional(),
  code: shortText(8).optional(),
  note: shortText(40).optional(),
});

/** A set of rows or options shows a photo on each or on none: never a mix. */
function allOrNone(photos: readonly unknown[]) {
  return photos.every(Boolean) || !photos.some(Boolean);
}

/** Photos one card may carry, whatever the blocks are. */
const maximumPhotos = 12;

export const blockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("heading"), text: shortText(80) }),
  z.strictObject({
    type: z.literal("text"),
    text: shortText(600),
    muted: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("facts"),
    rows: z
      .array(
        z.strictObject({
          label: shortText(40),
          value: shortText(120),
          strong: z.boolean().optional(),
        })
      )
      .min(1)
      .max(12),
  }),
  z.strictObject({
    type: z.literal("stat"),
    label: shortText(40),
    value: shortText(24),
    hint: shortText(80).optional(),
  }),
  z
    .strictObject({
      type: z.literal("list"),
      rows: z
        .array(
          z.strictObject({
            title: shortText(80),
            subtitle: shortText(120).optional(),
            side: shortText(40).optional(),
            chip: chipSchema.optional(),
            href: httpsUrl.optional(),
            photo: photoSchema.optional(),
          })
        )
        .min(1)
        .max(12),
      layout: z.enum(["rows", "carousel"]).default("rows"),
    })
    .refine(
      (list) =>
        allOrNone(list.rows.map((row) => row.photo)) &&
        (list.layout === "rows" ||
          (list.rows.length >= 2 &&
            list.rows.length <= 8 &&
            list.rows.every((row) => row.photo !== undefined))),
      "photos are on every row or on none, and a carousel is 2–8 rows that all have one"
    ),
  z.strictObject({
    type: z.literal("gallery"),
    photos: z.array(photoSchema).min(2).max(8),
    caption: shortText(100).optional(),
    ratio: z.enum(["wide", "square", "portrait"]).default("wide"),
  }),
  z.strictObject({
    type: z.literal("timeline"),
    steps: z
      .array(
        z.strictObject({
          title: shortText(80),
          detail: shortText(160).optional(),
          time: shortText(24).optional(),
          state: z.enum(["done", "current", "upcoming"]).default("upcoming"),
        })
      )
      .min(2)
      .max(10),
  }),
  z.strictObject({
    type: z.literal("route"),
    from: place,
    to: place,
    meta: shortText(80).optional(),
  }),
  z
    .strictObject({
      type: z.literal("table"),
      columns: z.array(shortText(24)).min(2).max(4),
      rows: z
        .array(z.array(shortText(40)).min(2).max(4))
        .min(1)
        .max(8),
      highlight: z.number().int().min(0).max(7).optional(),
    })
    .refine(
      (table) =>
        table.rows.every((row) => row.length === table.columns.length) &&
        (table.highlight === undefined || table.highlight < table.rows.length),
      "every row has one cell per column, and highlight names a row"
    ),
  z.strictObject({
    type: z.literal("callout"),
    tone: toneSchema,
    title: shortText(60).optional(),
    text: shortText(300),
  }),
  z.strictObject({
    type: z.literal("chips"),
    items: z.array(chipSchema).min(1).max(10),
  }),
  z.strictObject({
    type: z.literal("checklist"),
    items: z
      .array(
        z.strictObject({
          text: shortText(100),
          done: z.boolean().default(false),
        })
      )
      .min(1)
      .max(12),
  }),
  z.strictObject({
    type: z.literal("image"),
    url: httpsUrl,
    alt: shortText(120),
    caption: shortText(100).optional(),
  }),
  z.strictObject({
    type: z.literal("copyable"),
    label: shortText(40),
    value: shortText(80),
  }),
  z.strictObject({ type: z.literal("divider") }),
  z
    .strictObject({
      type: z.literal("choice"),
      id: identifier,
      label: shortText(80),
      options: z.array(optionSchema).min(2).max(8),
      multiple: z.boolean().default(false),
      required: z.boolean().default(true),
      initial: z.array(identifier).max(8).default([]),
      layout: z.enum(["list", "tiles", "carousel"]).default("list"),
    })
    .refine(
      (choice) =>
        new Set(choice.options.map((option) => option.value)).size ===
          choice.options.length &&
        choice.initial.every((value) =>
          choice.options.some((option) => option.value === value)
        ) &&
        (choice.multiple || choice.initial.length <= 1),
      "option values are unique, and initial names options (one for a single choice)"
    )
    .refine(
      (choice) =>
        allOrNone(choice.options.map((option) => option.photo)) &&
        (choice.layout === "list" ||
          choice.options.every((option) => option.photo !== undefined)),
      "photos are on every option or on none, and tiles and a carousel need one on each"
    ),
  z.strictObject({
    type: z.literal("field"),
    id: identifier,
    label: shortText(80),
    input: z.enum(["text", "longtext", "number", "date", "time"]),
    unit: shortText(12).optional(),
    hint: shortText(120).optional(),
    placeholder: shortText(60).optional(),
    required: z.boolean().default(true),
    initial: shortText(500).optional(),
  }),
]);

const linkAction = z.strictObject({
  label: shortText(30),
  href: actionHref,
  primary: z.boolean().optional(),
});

/** A button that sends what the person chose and typed on the card to Bro. */
const submitAction = z.strictObject({
  label: shortText(30),
  submit: identifier,
  primary: z.boolean().optional(),
});

export const cardSchema = z
  .strictObject({
    kicker: shortText(40).optional(),
    title: shortText(80),
    subtitle: shortText(160).optional(),
    tone: toneSchema.default("neutral"),
    blocks: z.array(blockSchema).min(1).max(16),
    actions: z
      .array(z.union([linkAction, submitAction]))
      .max(3)
      .default([]),
    footnote: shortText(200).optional(),
  })
  .refine((card) => {
    const ids = card.blocks.flatMap((block) =>
      block.type === "choice" || block.type === "field" ? [block.id] : []
    );
    const submits = card.actions.flatMap((action) =>
      "submit" in action ? [action.submit] : []
    );
    const photos = card.blocks.reduce((count, block) => {
      if (block.type === "image") return count + 1;
      if (block.type === "gallery") return count + block.photos.length;
      if (block.type === "list") {
        return count + block.rows.filter((row) => row.photo).length;
      }
      if (block.type === "choice") {
        return count + block.options.filter((option) => option.photo).length;
      }
      return count;
    }, 0);
    return (
      new Set(ids).size === ids.length &&
      new Set(submits).size === submits.length &&
      (ids.length === 0 || submits.length > 0) &&
      photos <= maximumPhotos
    );
  }, "field and choice ids are unique, button ids are unique, a card with fields has a button that sends them, and a card carries at most 12 photos");

export type Card = z.infer<typeof cardSchema>;
