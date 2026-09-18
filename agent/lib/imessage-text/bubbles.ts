/**
 * A long numbered dump reads as a wall of text in one iMessage bubble, so a
 * compiled message is split into the bubbles a person would actually have
 * typed: one per numbered item, or one per paragraph of a fact dump.
 */

import { toIMessageText } from "./compile";

const maximumBubbles = 8;
const numberedItemBoundary = /\n(?=\d+\.\s)/u;
const numberedLeadPattern = /^\d+\.\s/u;
const numberedItemPattern = /\n\d+\.\s/u;
const paragraphBoundary = /\n[ \t]*\n/u;
const markdownHeadingPattern = /^#{1,6}\s+\S/u;
const headingMarkupPattern = /[*_`#]/gu;
const trailingColonPattern = /:\s*$/u;
/** Below this an item is a phrase, not a section worth its own bubble. */
const numberedItemBubbleLength = 80;
/** Below this the whole message still reads fine as one bubble. */
const paragraphSplitLength = 180;
const headingWordLimit = 6;
const headingLengthLimit = 40;

/** Compiles one model message into the bubbles delivered in order. */
export function toIMessageBubbles(source: string) {
  const text = toIMessageText(source);
  if (!text) return [];

  const items = withLeadingHeading(
    text
      .split(numberedItemBoundary)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
  );
  if (items.length < 2) return paragraphBubbles(text);

  const substantialItems = items.filter(
    (item) =>
      item.length >= numberedItemBubbleLength &&
      (numberedLeadPattern.test(item) || numberedItemPattern.test(item))
  );
  if (substantialItems.length < 2) return paragraphBubbles(text);

  return items.slice(0, maximumBubbles).filter((item) => !isHeadingOnly(item));
}

/** A heading introduces the list, so it rides with the first item. */
function withLeadingHeading(items: readonly string[]) {
  const [heading, first, ...rest] = items;
  if (heading === undefined || first === undefined || !isHeadingOnly(heading)) {
    return items;
  }
  return [`${heading}\n${first}`, ...rest];
}

/** A fact dump separated by blank lines becomes a few bubbles, not a wall. */
function paragraphBubbles(text: string) {
  if (isHeadingOnly(text)) return [];
  const paragraphs = text
    .split(paragraphBoundary)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length < 2 || text.length < paragraphSplitLength) {
    return [text];
  }

  const bubbles: string[] = [];
  let heading = "";
  for (const paragraph of paragraphs) {
    if (isHeadingOnly(paragraph)) {
      heading = heading ? `${heading}\n${paragraph}` : paragraph;
      continue;
    }
    bubbles.push(heading ? `${heading}\n${paragraph}` : paragraph);
    heading = "";
  }
  const last = bubbles.at(-1);
  if (heading && last !== undefined) {
    bubbles[bubbles.length - 1] = `${last}\n${heading}`;
  }
  return bubbles.slice(0, maximumBubbles);
}

/** A bare section title such as `Тяжёлая артиллерия:` is never its own bubble. */
function isHeadingOnly(text: string) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n")) return false;
  if (markdownHeadingPattern.test(trimmed)) return true;
  const bare = trimmed.replaceAll(headingMarkupPattern, "").trim();
  const words = bare.split(/\s+/u).filter(Boolean);
  if (words.length === 0 || words.length > headingWordLimit) return false;
  if (bare.length > headingLengthLimit) return false;
  return trailingColonPattern.test(bare);
}
