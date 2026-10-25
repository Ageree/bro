import type { BroMandate, BroProposal } from "./contract";

/**
 * What the owner set for an errand themself (docs/bro-to-bro.md, «Что
 * владелец назвал сам»): the second version's time, venue and points of a
 * mandate, as code checked them against the owner's own words, and whether
 * an agreement is exactly that. Shared by the envoy and the gate, which let
 * it go without asking, and by the thread's step, which confirms the
 * initiator's side when the agreement is what the owner set.
 */

/** Words that only say what kind of place it is, or join its name. */
const genericPlaceWord =
  /^(?:в|во|на|у|к|ко|с|со|и|около|возле|рядом|напротив|ресторан\p{L}*|кафе|кафешк\p{L}*|бар|бары|баре|бара|паб\p{L}*|кофейн\p{L}*|пиццери\p{L}*|столов\p{L}*|бистро|гриль|парк\p{L}*|сквер\p{L}*|тц|трц|торгов\p{L}*|центр\p{L}*|кинотеатр\p{L}*|кино|музе\p{L}*|театр\p{L}*|клуб\p{L}*|метро|станци\p{L}*|заведени\p{L}*|место|месте)$/u;

/** A text's words as they compare: lower case, «ё» as «е», letters and digits. */
export function comparableWords(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replaceAll("ё", "е")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** How much of a word must match for its other forms: «пушкин» for «Пушкине». */
export function wordStem(word: string) {
  return word.length <= 4 ? word : word.slice(0, Math.max(4, word.length - 2));
}

/**
 * The words that name a place, without what only says its kind: every
 * number among them and every word of two letters or more, so «Пушкин, кв.
 * 12» is not «Пушкин».
 */
function placeWords(place: string) {
  return comparableWords(place).filter(
    (word) =>
      /\d/u.test(word) || (word.length >= 2 && !genericPlaceWord.test(word))
  );
}

/**
 * Whether every word naming `place` is among `words`, in any of its forms;
 * a place of generic words alone («кафе») names nothing.
 */
export function placeNamedIn(place: string, words: readonly string[]) {
  const wanted = placeWords(place);
  return (
    wanted.length > 0 &&
    wanted.every((word) =>
      words.some((each) => each.startsWith(wordStem(word)))
    )
  );
}

/**
 * Whether a text names nothing of a place but `venue`: «в Пушкине» of
 * «ресторан «Пушкин» на Тверском», but not «Пушкин, второй этаж».
 */
export function placeWithin(text: string, venue: string) {
  return placeNamedIn(text, comparableWords(venue));
}

/** Whether two places are the same one, as their names say. */
export function samePlace(left: string, right: string) {
  return placeWithin(left, right) && placeWithin(right, left);
}

/**
 * The time the owner set themself, when code found it in their words: their
 * exact start (`at`) or their window. Null when they named no time or code
 * did not find it in what they said.
 */
export function ownerTime(mandate: BroMandate | null) {
  if (!mandate?.ownerSaid?.time || !mandate.window) return null;
  return {
    exactStart: mandate.at ?? null,
    from: mandate.window.from,
    to: mandate.window.to,
  };
}

/**
 * Whether a proposal's time is the owner's own: their exact start, or
 * inside their window, and never past its end — an exact start's window is
 * as long as the meeting the errand set.
 */
export function ownerTimeCovers(
  time: ReturnType<typeof ownerTime>,
  proposal: Pick<BroProposal, "end" | "start">
) {
  if (!time || !proposal.start || !proposal.end) return false;
  const start = Date.parse(proposal.start);
  const end = Date.parse(proposal.end);
  if (!(end > start)) return false;
  if (end > Date.parse(time.to)) return false;
  if (time.exactStart !== null) return start === Date.parse(time.exactStart);
  return Date.parse(time.from) <= start;
}

/**
 * Whether an agreement is exactly what the initiator's owner set, so that
 * code confirms their side by itself: the owner's own time, the venue they
 * named (or no place, when they named none), no points and no sum — an
 * agreement about those the owner always confirms themself — and a meeting
 * that has not begun. Nothing the model says decides it.
 */
export function ownerSetCovers(
  mandate: BroMandate | null,
  proposal: BroProposal,
  now: Date
) {
  if (!mandate || !ownerTimeCovers(ownerTime(mandate), proposal)) return false;
  // An errand with points or a sum is one the owner confirms themself.
  if ((mandate.items?.length ?? 0) > 0 || (mandate.amountRub ?? null) !== null)
    return false;
  if (!proposal.start || Date.parse(proposal.start) <= now.getTime())
    return false;
  if ((proposal.items?.length ?? 0) > 0 || proposal.amountRub !== undefined)
    return false;
  const venue = mandate.ownerSaid?.place ? (mandate.place ?? null) : null;
  if (venue === null) return proposal.place === undefined;
  return proposal.place !== undefined && samePlace(proposal.place, venue);
}

/**
 * What the initiator's owner set for the errand (the second version's), as
 * the envoy reads it: the time, venue and sum code found in their own words,
 * the points of the errand, and what was named but not found — context.
 * Null for an errand that named none of it.
 */
export function ownerSetOf(mandate: BroMandate) {
  const said = mandate.ownerSaid;
  const time = ownerTime(mandate);
  const place = mandate.place ?? null;
  const amountRub = mandate.amountRub ?? null;
  if (!time && place === null && amountRub === null && !mandate.items)
    return null;
  return {
    time: time && {
      end: time.to,
      exact: time.exactStart !== null,
      start: time.exactStart ?? time.from,
    },
    place: said?.place ? place : null,
    items: said?.items ? (mandate.items ?? null) : null,
    amountRub: said?.amount ? amountRub : null,
    unconfirmed: {
      place: said?.place ? null : place,
      items: said?.items ? null : (mandate.items ?? null),
      amountRub: said?.amount ? null : amountRub,
    },
  };
}
