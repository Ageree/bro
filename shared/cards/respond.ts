import * as z from "zod";
import { cardAnswerSchema, cardDraftSchema } from "./response";
import { cardSchema } from "./schema";

/**
 * What a card's page and `POST /api/cards/[id]/respond` say to each other.
 * `open` asks whether the viewer may answer the card at this revision and
 * what they already answered; `send` sends the answer of a submit button;
 * `watch` asks, again and again while the page is open, how the card and
 * the person's latest press on it stand. Each carries Telegram's signed
 * launch data, which names the viewer.
 */
export const respondRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    initData: z.string().max(8192),
    kind: z.literal("open"),
    revision: z.number().int().positive(),
  }),
  z.object({
    action: z.string().max(32),
    initData: z.string().max(8192),
    kind: z.literal("send"),
    item: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/u)
      .optional(),
    revision: z.number().int().positive(),
    values: cardDraftSchema,
  }),
  z.object({
    initData: z.string().max(8192),
    kind: z.literal("watch"),
    revision: z.number().int().positive(),
  }),
]);

/**
 * How the person's latest press on the card stands
 * (`readCardPress` in `db/services/cards.ts`): `waiting` for Bro's turn,
 * `queued` behind the turn of an earlier press, `working` in its turn,
 * `searching` while a browser run that turn started has not reported,
 * `done` once the turn is over, `failed` when it never became one.
 */
const cardPressSchema = z.object({
  action: z.string(),
  item: z.string().optional(),
  kind: z.enum(["submit", "intent"]),
  revision: z.number().int().positive(),
  stage: z.enum([
    "waiting",
    "queued",
    "working",
    "searching",
    "done",
    "failed",
  ]),
});

const kept = {
  answer: cardAnswerSchema,
  delivery: z.enum(["received", "delivered", "failed"]),
};

/**
 * The server's word: `open` — yours to answer; `sent` — your answer is kept
 * (`delivery`: how far it got to Bro); `answered` — another answer to this
 * revision was kept before; `invalid` and `secret` — what to fix, by the
 * question's id; `foreign` — the card is someone else's; `unverified` — no
 * signed launch data; `stale` — the card changed since the page loaded;
 * `closed` — the card takes no answers; `busy` — too many answers in a row;
 * `watch` — how the card stands now: its revision, the card itself when it
 * is newer than the page's, the answer kept for that revision and the
 * person's latest press.
 */
export const respondReplySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("open") }),
  z.object({ ...kept, status: z.literal("sent") }),
  z.object({ ...kept, status: z.literal("answered") }),
  z.object({
    status: z.literal("intent"),
    outcome: z.enum(["received", "replaced", "repeat"]),
    press: cardPressSchema.optional(),
  }),
  z.object({
    answer: z.object(kept).optional(),
    card: cardSchema.optional(),
    press: cardPressSchema.optional(),
    revision: z.number().int().positive(),
    status: z.literal("watch"),
  }),
  z.object({
    issues: z.array(
      z.object({ id: z.string().nullable(), message: z.string() })
    ),
    status: z.literal("invalid"),
  }),
  z.object({
    id: z.string(),
    kind: z.enum(["card-number", "document", "secret"]),
    status: z.literal("secret"),
  }),
  z.object({
    status: z.enum([
      "busy",
      "closed",
      "foreign",
      "gone",
      "malformed",
      "refused",
      "stale",
      "unverified",
    ]),
  }),
]);
