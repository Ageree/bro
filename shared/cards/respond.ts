import * as z from "zod";
import { cardAnswerSchema, cardDraftSchema } from "./response";

/**
 * What a card's page and `POST /api/cards/[id]/respond` say to each other.
 * `open` asks whether the viewer may answer the card at this revision and
 * what they already answered; `send` sends the answer of a submit button.
 * Both carry Telegram's signed launch data, which names the viewer.
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
    revision: z.number().int().positive(),
    values: cardDraftSchema,
  }),
]);

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
 * `closed` — the card takes no answers; `busy` — too many answers in a row.
 */
export const respondReplySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("open") }),
  z.object({ ...kept, status: z.literal("sent") }),
  z.object({ ...kept, status: z.literal("answered") }),
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
