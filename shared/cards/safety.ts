import * as z from "zod";
import { looksLikeCardNumber } from "@shared/privacy/card-number";
import { documentNumberRanges } from "@shared/privacy/document-numbers";
import { unsafeMemoryRanges } from "@shared/memory/schema";
import { type CardAnswer, cardQuestions } from "./response";
import type { Card } from "./schema";

/**
 * What a card must never show or take (`docs/cards.md`): a full card
 * number, a password, a key, a one-time code or a document's number. A link
 * is not text the person reads, and a long number in its path is no card.
 * `send_card` and `update_card` refuse a card that shows one, and the
 * server turns away an answer that carries one.
 */

const jsonSchema = z.json();
const jsonListSchema = z.array(jsonSchema);
const jsonRecordSchema = z.record(z.string(), jsonSchema);

const linkFields: ReadonlySet<string> = new Set(["href", "url"]);

/** 13–19 digits, apart or split by spaces and hyphens, not part of a longer number. */
const cardNumberPattern = /(?<!\d[ -]?)\d(?:[ -]?\d){12,18}(?![ -]?\d)/gu;
const cardNumberStart = /^\d(?:[ -]?\d){12,18}/u;

interface Leaf {
  readonly path: string;
  readonly text: string;
}

function leavesOf(value: z.infer<typeof jsonSchema>, path: string): Leaf[] {
  const text = z.string().safeParse(value);
  if (text.success) return [{ path, text: text.data }];
  const list = jsonListSchema.safeParse(value);
  if (list.success) {
    return list.data.flatMap((item, index) =>
      leavesOf(item, `${path}[${String(index)}]`)
    );
  }
  const record = jsonRecordSchema.safeParse(value);
  if (!record.success) return [];
  return Object.entries(record.data).flatMap(([key, item]) =>
    linkFields.has(key)
      ? []
      : leavesOf(item, path === "" ? key : `${path}.${key}`)
  );
}

/**
 * Which secret a text shows, if any. A group of digits as long as a card
 * number that fails Luhn is an order or a parcel, which the memory's check
 * cannot tell from a card, so only Luhn decides for those.
 */
function secretKind(text: string) {
  if (
    [...text.matchAll(cardNumberPattern)].some(([run]) =>
      looksLikeCardNumber(run)
    )
  ) {
    return "card-number" as const;
  }
  if (documentNumberRanges(text).length > 0) return "document" as const;
  const secret = unsafeMemoryRanges(text).some(
    ([start]) => !cardNumberStart.test(text.slice(start))
  );
  return secret ? ("secret" as const) : undefined;
}

/**
 * The first text of the card or of its chat message that shows a full card
 * number (13–19 digits that pass Luhn), a passport's or SNILS number, or a
 * password, a key or a one-time code (`unsafeMemoryRanges`): where it stands
 * and which kind it is.
 */
export function secretInCard(card: Card, message: string) {
  for (const { path, text } of leavesOf(
    jsonSchema.parse({ ...card, message }),
    ""
  )) {
    const kind = secretKind(text);
    if (kind !== undefined) return { kind, path };
  }
  return undefined;
}

/**
 * What a field may not ask for, by the words of its label, hint or
 * placeholder: a password, a PIN, a CVC or a code from a message; a card's
 * number; a passport or SNILS. A booking code, a promo code or an intercom's
 * code is none of them.
 */
const askedSecrets = [
  {
    kind: "secret",
    pattern:
      /парол|password|passcode|пин-?код|(?<!\p{L})pin(?!\p{L})|cvc|cvv|одноразов|код (?:из|в) (?:смс|sms|сообщени|письм|приложени)|(?:смс|sms)-?код|код подтвержд|проверочн\p{L}* код|(?<!\p{L})otp(?!\p{L})/iu,
  },
  {
    kind: "card-number",
    pattern:
      /номер\p{L}* (?:банковской )?карт|card number|срок действия карт/iu,
  },
  { kind: "document", pattern: /паспорт|passport|снилс|snils/iu },
] as const;

/**
 * The first field of the card that asks the person for one of these, and
 * which kind it asks for: a card never takes them, whatever the answer.
 */
export function secretAsked(card: Card) {
  for (const [index, block] of card.blocks.entries()) {
    if (block.type !== "field") continue;
    const words = [block.label, block.hint, block.placeholder].join(" ");
    const asked = askedSecrets.find(({ pattern }) => pattern.test(words));
    if (asked) return { kind: asked.kind, path: `blocks[${String(index)}]` };
  }
  return undefined;
}

/**
 * The first field of the person's answer that carries one of these: its id
 * and which kind it is. A field's words count with its label — «Пароль от
 * wifi» over «Kot2024!» — so a code asked for by its label is one too.
 */
export function secretInAnswer(card: Card, answer: CardAnswer) {
  for (const question of cardQuestions(card)) {
    const value = answer.values[question.id];
    if (question.type !== "field" || value === undefined) continue;
    const kind = secretKind(`${question.label}: ${String(value)}`);
    if (kind !== undefined) return { id: question.id, kind };
  }
  return undefined;
}
