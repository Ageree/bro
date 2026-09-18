/**
 * iMessage renders no Markdown, so the model's lightly formatted text is
 * compiled into plain text that reads correctly inside a bubble. Photon cannot
 * send iOS text styles either, so Latin `**bold**` becomes Mathematical
 * Sans-Serif Bold, which an iPhone draws as bold. A Cyrillic field label gets a
 * leading ▸ instead: half a word in fake-bold and half in ordinary Cyrillic
 * looks broken rather than emphasized.
 */

const fencePattern = /```[\w+-]*\n?([\s\S]*?)```/gu;
const imagePattern =
  /!{1,2}\[([^\]]*)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/giu;
const linkPattern = /\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/giu;
const autoLinkPattern = /<(https?:\/\/[^>\s]+)>/giu;
const autoMailPattern = /<([^>\s]+@[^>\s]+)>/gu;
// `:::rich`, `:::buttons` and their closing `:::` are container fences some
// chat surfaces understand and iMessage does not; only the marker lines go.
const containerFencePattern = /^:::[\w-]*[ \t]*$/gmu;
const headingPattern = /^#{1,6}\s+(.*)$/gmu;
const quotePattern = /^>!?\s?/gmu;
const bulletPattern = /^[ \t]*[-*]\s+/gmu;
const strikethroughPattern = /~~([^~\n]+)~~/gu;
const inlineCodePattern = /`([^`\n]+)`/gu;
const underlinePattern = /\+\+([^+\n]+)\+\+/gu;
const spoilerPattern = /\|\|([^|\n]+)\|\|/gu;
const boldItalicPattern = /\*\*\*([^*]+)\*\*\*/gu;
const boldPattern = /\*\*([^*]+)\*\*/gu;
const underscoreBoldPattern = /__([^_]+)__/gu;
const italicPattern = /(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/gu;
const strayBoldPattern = /\*\*/gu;
const alphanumericPattern = /\p{L}|\p{N}/u;
const nonSpacePattern = /\S/gu;
/** Field labels an inbox or order summary repeats line after line. */
const fieldLabelPattern =
  /^(\d+\.\s*)?(От|Тема|Дата|Предварительный текст|From|Subject|Date|To|Preview)\s*:/u;

const boldUppercaseBase = 0x1d_5d4;
const boldLowercaseBase = 0x1d_5ee;
const boldDigitBase = 0x1d_7ec;
const italicUppercaseBase = 0x1d_608;
const italicLowercaseBase = 0x1d_622;
const combiningLongStrokeOverlay = "̶";

/**
 * Mathematical Sans-Serif Bold, and only when every letter and digit maps.
 * A partly mapped word such as `𝗢т` reads as a rendering bug.
 */
export function toIMessageBold(text: string) {
  return toStyledText(
    text,
    boldUppercaseBase,
    boldLowercaseBase,
    boldDigitBase
  );
}

/** Compiles one model message into the text a single iMessage bubble shows. */
export function toIMessageText(source: string) {
  const flattened = source
    .replaceAll("\r\n", "\n")
    .replaceAll(fencePattern, (_match, body: string) =>
      body.replace(/\n+$/u, "\n")
    )
    .replaceAll(imagePattern, (_match, alt: string, url: string) =>
      captionedUrl(alt.replaceAll("*", ""), url)
    )
    .replaceAll(linkPattern, (_match, label: string, url: string) =>
      captionedUrl(label.replaceAll(/[*_`]+/gu, ""), url)
    )
    .replaceAll(autoLinkPattern, "$1")
    .replaceAll(autoMailPattern, "$1")
    .replaceAll(containerFencePattern, "")
    .replaceAll(headingPattern, (_match, heading: string) =>
      toIMessageBold(heading.trim())
    )
    .replaceAll(quotePattern, "")
    .replaceAll(bulletPattern, "• ")
    .replaceAll(strikethroughPattern, (_match, text: string) =>
      strikeThrough(text)
    )
    .replaceAll(inlineCodePattern, "$1")
    .replaceAll(underlinePattern, "$1")
    .replaceAll(spoilerPattern, "$1")
    .replaceAll(boldItalicPattern, (_match, text: string) =>
      toIMessageBold(text)
    )
    .replaceAll(boldPattern, (_match, text: string) => toIMessageBold(text))
    .replaceAll(underscoreBoldPattern, (_match, text: string) =>
      toIMessageBold(text)
    )
    .replaceAll(
      italicPattern,
      (_match, before: string, text: string) => before + toItalic(text)
    )
    .replaceAll(strayBoldPattern, "");

  return markFieldLabels(collapseWhitespace(flattened));
}

function captionedUrl(rawCaption: string, rawUrl: string) {
  const caption = rawCaption.trim();
  const url = rawUrl.trim();
  if (!caption || caption === url) return url;
  return `${caption}\n${url}`;
}

function collapseWhitespace(text: string) {
  return text
    .split("\n")
    .map((line) => line.replaceAll(/[ \t]+/gu, " ").trim())
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}

function toItalic(text: string) {
  return toStyledText(text, italicUppercaseBase, italicLowercaseBase, null);
}

function toStyledText(
  text: string,
  uppercaseBase: number,
  lowercaseBase: number,
  digitBase: number | null
) {
  let styled = "";
  let alphanumeric = 0;
  let mapped = 0;
  for (const character of text) {
    if (alphanumericPattern.test(character)) alphanumeric++;
    const replacement = styledCharacter(
      character,
      uppercaseBase,
      lowercaseBase,
      digitBase
    );
    if (replacement === undefined) {
      styled += character;
      continue;
    }
    styled += replacement;
    mapped++;
  }
  return mapped === 0 || mapped < alphanumeric ? text : styled;
}

function styledCharacter(
  character: string,
  uppercaseBase: number,
  lowercaseBase: number,
  digitBase: number | null
) {
  const code = character.codePointAt(0);
  if (code === undefined) return undefined;
  if (code >= 0x41 && code <= 0x5a) {
    return String.fromCodePoint(uppercaseBase + (code - 0x41));
  }
  if (code >= 0x61 && code <= 0x7a) {
    return String.fromCodePoint(lowercaseBase + (code - 0x61));
  }
  if (digitBase !== null && code >= 0x30 && code <= 0x39) {
    return String.fromCodePoint(digitBase + (code - 0x30));
  }
  return undefined;
}

function strikeThrough(text: string) {
  return text.replaceAll(
    nonSpacePattern,
    (character) => character + combiningLongStrokeOverlay
  );
}

/**
 * A Latin label is emphasized in place; a Cyrillic one, which cannot be
 * fake-bolded, is marked with ▸ so a stack of labels still scans.
 */
function markFieldLabels(text: string) {
  return text
    .split("\n")
    .map((line) => {
      const match = fieldLabelPattern.exec(line);
      const label = match?.[2];
      if (!label) return line;
      const emphasized = toIMessageBold(label);
      if (emphasized !== label) return line.replace(label, emphasized);
      const ordinal = match[1] ?? "";
      const body = line.slice(ordinal.length);
      return body.startsWith("▸ ") ? line : `${ordinal}▸ ${body}`;
    })
    .join("\n");
}
