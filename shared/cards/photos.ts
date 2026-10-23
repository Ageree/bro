import { createHash } from "node:crypto";
import type { Card } from "@shared/cards/schema";
import { deleteArtifactObject } from "@shared/object-storage/artifacts";

/**
 * Bro's own copies of the photos on a card (`docs/cards.md`, «Фото в
 * карточках»). `send_card` copies each photo into Object Storage and puts the
 * copy's address in the card; the page reads it by the card's link, and the
 * copies go when the card expires. An object's key names the card by a hash of
 * its link, because the link is the secret and a key turns up in the store's
 * own errors and logs.
 */

const keptPath =
  /"\/api\/cards\/(?<card>[A-Za-z0-9_-]{43})\/photos\/(?<number>0|[1-9]\d{0,2})"/gu;

/** The address the card's page reads its photo number `number` at. */
export function cardPhotoPath(cardId: string, number: number) {
  return `/api/cards/${cardId}/photos/${String(number)}`;
}

/** Where the copy of the card's photo number `number` lies in Object Storage. */
export function cardPhotoObject(cardId: string, number: number) {
  const card = createHash("sha256").update(cardId).digest("base64url");
  return `card-photos/${card}/${String(number)}`;
}

/**
 * The numbers of this card's own copies that a kept card shows. Read from the
 * card's text rather than its blocks, so a card the schema has since moved on
 * from still gives up the copies it names.
 */
export function keptPhotoNumbers(cardId: string, card: Card) {
  return [...JSON.stringify(card).matchAll(keptPath)].flatMap(({ groups }) =>
    groups?.card === cardId ? [Number(groups.number)] : []
  );
}

/**
 * Removes the card's copies by number; one already gone counts as removed.
 * Throws when the store refused one, so the caller keeps what still names it.
 */
export async function deleteCardPhotos(
  cardId: string,
  numbers: readonly number[]
) {
  await Promise.all(
    numbers.map((number) =>
      deleteArtifactObject(cardPhotoObject(cardId, number))
    )
  );
}
