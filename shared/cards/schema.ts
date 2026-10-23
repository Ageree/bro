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

const place = z.strictObject({
  place: shortText(40),
  time: shortText(16).optional(),
  code: shortText(8).optional(),
  note: shortText(40).optional(),
});

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
  z.strictObject({
    type: z.literal("list"),
    rows: z
      .array(
        z.strictObject({
          title: shortText(80),
          subtitle: shortText(120).optional(),
          side: shortText(40).optional(),
          chip: chipSchema.optional(),
          href: httpsUrl.optional(),
        })
      )
      .min(1)
      .max(12),
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
]);

export const cardSchema = z.strictObject({
  kicker: shortText(40).optional(),
  title: shortText(80),
  subtitle: shortText(160).optional(),
  tone: toneSchema.default("neutral"),
  blocks: z.array(blockSchema).min(1).max(16),
  actions: z
    .array(
      z.strictObject({
        label: shortText(30),
        href: actionHref,
        primary: z.boolean().optional(),
      })
    )
    .max(3)
    .default([]),
  footnote: shortText(200).optional(),
});

export type Card = z.infer<typeof cardSchema>;
