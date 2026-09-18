/**
 * Converts the model's lightly formatted plain text into the small HTML subset
 * Telegram's `parse_mode: "HTML"` accepts, and splits it into messages that fit
 * the Bot API's 4096-character cap without cutting a tag in half.
 */

/** Telegram's documented `sendMessage` text cap. */
export const telegramMessageTextMaxLength = 4096;

const fencePattern = /^\s*```/u;
const bulletPattern = /^(?<indent>\s*)[-*]\s+(?<content>.*)$/u;
const inlineCodePattern = /`([^`]+)`/u;
const linkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu;
const boldPattern = /\*\*(?!\s)([^*\n]+?)\*\*/gu;
const italicPattern = /(^|[^\w`])_(?!\s)([^_\n]+?)_(?=$|[^\w])/gu;
// Escaped text never contains a literal angle bracket, so `<index>` is a
// placeholder no user content can forge while emphasis is applied.
const anchorPlaceholderPattern = /<(\d+)>/gu;

export function toTelegramHtml(text: string) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const rendered: string[] = [];
  let fenced: string[] | undefined;

  for (const line of lines) {
    if (fencePattern.test(line)) {
      if (fenced) {
        rendered.push(`<pre>${escapeTelegramHtml(fenced.join("\n"))}</pre>`);
        fenced = undefined;
      } else {
        fenced = [];
      }
      continue;
    }
    if (fenced) {
      fenced.push(line);
      continue;
    }
    const bullet = bulletPattern.exec(line);
    rendered.push(
      bullet?.groups
        ? `${bullet.groups.indent ?? ""}• ${inlineHtml(bullet.groups.content ?? "")}`
        : inlineHtml(line)
    );
  }
  if (fenced) {
    rendered.push(`<pre>${escapeTelegramHtml(fenced.join("\n"))}</pre>`);
  }

  return rendered.join("\n").trim();
}

/**
 * Splits rendered Telegram HTML with the same newline-then-space preference
 * eve's `splitTelegramMessageText` uses, while never cutting inside a tag or
 * between an opening tag and its closing tag.
 */
export function splitTelegramHtml(html: string) {
  if (html.length <= telegramMessageTextMaxLength) return [html];
  const messages: string[] = [];
  let rest = html;
  while (rest.length > telegramMessageTextMaxLength) {
    const cut = cutIndex(rest);
    messages.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  messages.push(rest);
  return messages;
}

function escapeTelegramHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inlineHtml(line: string) {
  const parts: string[] = [];
  let rest = line;
  for (;;) {
    const code = inlineCodePattern.exec(rest);
    if (!code) break;
    parts.push(
      markupHtml(rest.slice(0, code.index)),
      `<code>${escapeTelegramHtml(code[1] ?? "")}</code>`
    );
    rest = rest.slice(code.index + code[0].length);
  }
  parts.push(markupHtml(rest));
  return parts.join("");
}

function markupHtml(text: string) {
  // Anchors are parked behind placeholders so emphasis never rewrites a URL.
  const anchors: string[] = [];
  const withAnchors = escapeTelegramHtml(text).replaceAll(
    linkPattern,
    (_match, label: string, url: string) => {
      anchors.push(`<a href="${url}">${label}</a>`);
      return `<${String(anchors.length - 1)}>`;
    }
  );
  return withAnchors
    .replaceAll(boldPattern, "<b>$1</b>")
    .replaceAll(italicPattern, "$1<i>$2</i>")
    .replaceAll(
      anchorPlaceholderPattern,
      (match, index: string) => anchors[Number(index)] ?? match
    );
}

function cutIndex(html: string) {
  let depth = 0;
  let insideTag = false;
  let lastNewline = 0;
  let lastSpace = 0;
  let lastBoundary = 0;

  for (let index = 0; index <= telegramMessageTextMaxLength; index++) {
    const character = html[index];
    if (character === undefined) break;
    if (insideTag) {
      if (character === ">") insideTag = false;
      continue;
    }
    if (character === "<") {
      insideTag = true;
      depth += html[index + 1] === "/" ? -1 : 1;
      continue;
    }
    if (depth > 0) continue;
    lastBoundary = index;
    if (character === "\n") lastNewline = index;
    else if (character === " ") lastSpace = index;
  }

  if (lastNewline > 0) return lastNewline;
  if (lastSpace > 0) return lastSpace;
  return lastBoundary > 0 ? lastBoundary : telegramMessageTextMaxLength;
}
