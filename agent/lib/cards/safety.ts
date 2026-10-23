import { z } from "zod";
import { looksLikeCardNumber } from "@agent/lib/browser-use/outcome";
import { documentNumberRanges } from "@agent/lib/privacy/document-numbers";
import type { Card } from "@shared/cards/schema";
import { unsafeMemoryRanges } from "@shared/memory/schema";

/**
 * What a card must never show (`docs/cards.md`): a full card number, a
 * password, a key, a one-time code or a document's number. A link is not text the person reads,
 * and a long number in its path is no card.
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
