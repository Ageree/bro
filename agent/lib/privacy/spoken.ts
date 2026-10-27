import { unsafeMemoryRanges } from "@shared/memory/schema";

/** Text that names a door, a flat or a code. */
const doorWords = /домофон|подъезд|этаж|квартир|(?<!\p{L})кв\.|код|парол/iu;

/**
 * Whether a voice may say Bro's record aloud: no credential or one-time code
 * (`unsafeMemoryRanges`), and nothing that names a door, a flat or a code —
 * kept for Bro's own errands, never for a stranger on a call
 * (`agent/lib/phone/ask.ts`) or a room around the person on /talk
 * (`agent/lib/voice/brief.ts`).
 */
export function sayableAloud(text: string) {
  return !doorWords.test(text) && unsafeMemoryRanges(text).length === 0;
}
