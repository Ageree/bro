/** Model markdown → Telegram HTML. Cyrillic bold/italic work natively.
 *  MarkdownV2 is not used — escaping it breaks Russian and URLs.
 *  Structured cards also compile to Bot API rich HTML (`sendRichMessage`). */

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_RICH_TEXT_LIMIT = 32_768;

const FENCE = /```([\w+-]*)\n?([\s\S]*?)```/g;
const BUTTONS = /:::buttons\s*\n([\s\S]*?):::/g;
// Shared with imessage-text.ts — only ever used via .replace(), which always
// scans from index 0 regardless of lastIndex, so sharing these `g` regexes
// across modules is safe. Do not use these with .exec/.test in a loop.
export const IMAGE = /!{1,2}\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+|callback:[^)\s]+)\)/gi;
export const AUTO_URL = /<(https?:\/\/[^>\s]+)>/gi;
export const AUTO_MAIL = /<([^>\s]+@[^>\s]+)>/g;
const RICH_MARK = /^:::rich\s*$/gm;
const RICH_BLOCK_LINE =
  /^<(?:h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|figure|figcaption|pre|details|summary|hr|p|img)\b/i;

export type TelegramButton = {
  text: string;
  url?: string;
  callback_data?: string;
};

export type TelegramPhotoRef = {
  url: string;
  spoiler: boolean;
};

export type TelegramCompiled = {
  html: string;
  richHtml: string;
  preferRich: boolean;
  chunks: string[];
  buttons: TelegramButton[][];
  photos: TelegramPhotoRef[];
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function extractButtons(src: string): {
  text: string;
  buttons: TelegramButton[][];
} {
  const rows: TelegramButton[][] = [];
  const text = src.replace(BUTTONS, (_, body: string) => {
    const row: TelegramButton[] = [];
    for (const line of String(body).split("\n")) {
      const m = line.trim().match(/^\[([^\]]+)\]\((.+)\)$/);
      if (!m) continue;
      const label = m[1]!.replace(/[*_`]+/g, "").trim();
      const dest = m[2]!.trim();
      if (!label) continue;
      if (dest.startsWith("callback:")) {
        const data = dest.slice("callback:".length).slice(0, 64);
        if (data) row.push({ text: label.slice(0, 64), callback_data: data });
      } else if (/^https?:\/\//i.test(dest)) {
        row.push({ text: label.slice(0, 64), url: dest });
      }
    }
    if (row.length) rows.push(row);
    return "";
  });
  return { text, buttons: rows };
}

function isSpoilerPhotoAlt(alt: string, bangs: string): boolean {
  const marker = alt.trim().toLowerCase();
  return bangs.length >= 2 || marker.startsWith("!") || marker.startsWith("spoiler");
}

/** Consecutive `>` lines become one quote. `>!` or a trailing `||` makes it expandable. */
function applyQuoteBlocks(s: string, join = "\n"): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines[i] ?? "";
    const expandableLine = /^&gt;!\s?(.*)$/.exec(start);
    const regularLine = /^&gt;\s?(.*)$/.exec(start);
    if (!expandableLine && !regularLine) {
      out.push(start);
      i += 1;
      continue;
    }
    let expandable = Boolean(expandableLine);
    const body: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      const exp = /^&gt;!\s?(.*)$/.exec(cur);
      const reg = /^&gt;\s?(.*)$/.exec(cur);
      if (!exp && !reg) break;
      if (exp) expandable = true;
      let inner = exp?.[1] ?? reg?.[1] ?? "";
      if (inner.endsWith("||")) {
        expandable = true;
        inner = inner.slice(0, -2).trimEnd();
      }
      body.push(inner);
      i += 1;
    }
    const inner = body.join(join);
    out.push(
      expandable
        ? `<blockquote expandable>${inner}</blockquote>`
        : `<blockquote>${inner}</blockquote>`,
    );
  }
  return out.join("\n");
}

function applyInlineMarkdown(escaped: string): string {
  let s = escaped;
  s = s.replace(AUTO_URL, "$1");
  s = s.replace(AUTO_MAIL, "$1");
  s = s.replace(LINK, (_, label: string, dest: string) => {
    const l = String(label).replace(/[*_`]+/g, "").trim();
    const u = String(dest).trim();
    if (u.startsWith("callback:")) return l;
    if (!l || l === u) return u;
    return `<a href="${u}">${l}</a>`;
  });
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/\+\+([^+\n]+)\+\+/g, "<u>$1</u>");
  s = s.replace(/\|\|([^|\n]+)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<b><i>$1</i></b>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_]+)__/g, "<b>$1</b>");
  s = s.replace(
    /(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g,
    (_, a: string, t: string) => `${a}<i>${t}</i>`,
  );
  return s.replace(/\*\*/g, "");
}

function collapseChatLines(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function applyMarkdown(escaped: string): string {
  let s = applyInlineMarkdown(escaped);
  s = s.replace(/^#{1,6}\s+(.*)$/gm, (_, t: string) => `<b>${t.trim()}</b>`);
  s = applyQuoteBlocks(s);
  s = s.replace(/^\s*[-*]\s+/gm, "• ");
  return collapseChatLines(s);
}

function richListItem(raw: string): string {
  const check = /^\[([ xX])\]\s+(.*)$/.exec(raw);
  if (!check) return raw;
  const checked = check[1] !== " ";
  return `<input type="checkbox"${checked ? " checked" : ""}/> ${check[2]}`;
}

function applyRichLists(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const unordered = /^\s*[-*]\s+(.*)$/.exec(lines[i] ?? "");
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(lines[i] ?? "");
    if (!unordered && !ordered) {
      out.push(lines[i] ?? "");
      i += 1;
      continue;
    }
    const items: string[] = [];
    const numbered = Boolean(ordered) && !unordered;
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      const u = /^\s*[-*]\s+(.*)$/.exec(cur);
      const o = /^\s*\d+\.\s+(.*)$/.exec(cur);
      if (numbered) {
        if (!o) break;
        items.push(`<li>${richListItem(o[1] ?? "")}</li>`);
      } else {
        if (!u) break;
        items.push(`<li>${richListItem(u[1] ?? "")}</li>`);
      }
      i += 1;
    }
    out.push(numbered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
  }
  return out.join("\n");
}

function applyRichTables(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  const cells = (line: string): string[] | null => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.length < 3) {
      return null;
    }
    return trimmed
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
  };
  const isSep = (row: string[]): boolean =>
    row.length > 0 && row.every((c) => /^:?-+:?$/.test(c) && c.includes("-"));
  while (i < lines.length) {
    const header = cells(lines[i] ?? "");
    const next = cells(lines[i + 1] ?? "");
    if (!header || !next || !isSep(next) || header.length === 0) {
      out.push(lines[i] ?? "");
      i += 1;
      continue;
    }
    const rows: string[][] = [header];
    i += 2;
    while (i < lines.length) {
      const row = cells(lines[i] ?? "");
      if (!row) break;
      rows.push(row);
      i += 1;
    }
    const body = rows
      .map((row, idx) => {
        const tag = idx === 0 ? "th" : "td";
        return `<tr>${row.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
      })
      .join("");
    out.push(`<table>${body}</table>`);
  }
  return out.join("\n");
}

function applyRichHeadings(s: string): string {
  return s.replace(/^(#{1,6})\s+(.*)$/gm, (_, hashes: string, title: string) => {
    const n = Math.min(6, hashes.length);
    return `<h${n}>${title.trim()}</h${n}>`;
  });
}

function wrapRichParagraphs(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = (): void => {
    const text = para.join("\n").trim();
    para = [];
    if (text) out.push(`<p>${text.replace(/\n/g, "<br/>")}</p>`);
  };
  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (RICH_BLOCK_LINE.test(line) || /^\u0000[PF]\d+\u0000$/.test(line.trim())) {
      flush();
      out.push(line);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join("\n");
}

function applyRichMarkdown(escaped: string): string {
  let s = applyInlineMarkdown(escaped);
  s = applyRichHeadings(s);
  s = applyRichTables(s);
  s = applyQuoteBlocks(s, "<br/>");
  s = applyRichLists(s);
  s = collapseChatLines(s);
  return wrapRichParagraphs(s);
}

function richFigure(photo: TelegramPhotoRef, alt: string): string {
  const src = escapeHtml(photo.url);
  const spoiler = photo.spoiler ? " tg-spoiler" : "";
  const caption = alt.replace(/^!/, "").replace(/^spoiler:?\s*/i, "").trim();
  const figcaption = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";
  return `<figure><img src="${src}"${spoiler}/>${figcaption}</figure>`;
}

export function isTelegramRichHtml(html: string): boolean {
  return /<(?:h[1-6]|ul|ol|table|details|blockquote expandable)\b/i.test(html);
}

export function toTelegramHtml(src: string): string {
  return compileTelegram(src).html;
}

export function compileTelegram(src: string): TelegramCompiled {
  let s = src.replace(/\r\n/g, "\n");
  const forceRich = /^:::rich\s*$/m.test(s);
  s = s.replace(RICH_MARK, "");
  const { text, buttons } = extractButtons(s);
  s = text;

  const photos: TelegramPhotoRef[] = [];
  const figures: string[] = [];
  s = s.replace(IMAGE, (match: string, alt: string, url: string) => {
    const bangs = match.startsWith("!!") ? "!!" : "!";
    const photo = {
      url: String(url).trim(),
      spoiler: isSpoilerPhotoAlt(String(alt), bangs),
    };
    photos.push(photo);
    figures.push(richFigure(photo, String(alt)));
    return `\u0000P${figures.length - 1}\u0000`;
  });

  const fences: string[] = [];
  s = s.replace(FENCE, (_, lang: string, body: string) => {
    const code = escapeHtml(String(body).replace(/\n+$/, ""));
    const tag = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>`
      : `<pre>${code}</pre>`;
    fences.push(tag);
    return `\u0000F${fences.length - 1}\u0000`;
  });

  const restore = (html: string): string =>
    html
      .replace(/\u0000P(\d+)\u0000/g, (_, i: string) => figures[Number(i)] ?? "")
      .replace(/\u0000F(\d+)\u0000/g, (_, i: string) => fences[Number(i)] ?? "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const html = restore(applyMarkdown(escapeHtml(s.replace(/\u0000P\d+\u0000/g, ""))));
  const richHtml = restore(applyRichMarkdown(escapeHtml(s)));
  const preferRich =
    (forceRich || isTelegramRichHtml(richHtml)) &&
    richHtml.length > 0 &&
    richHtml.length <= TELEGRAM_RICH_TEXT_LIMIT;

  return {
    html,
    richHtml,
    preferRich,
    chunks: splitTelegramHtml(html),
    buttons,
    photos,
  };
}

/** Prefer paragraph breaks so we do not split inside a tag. */
export function splitTelegramHtml(
  html: string,
  limit = TELEGRAM_TEXT_LIMIT,
): string[] {
  if (!html) return [];
  if (html.length <= limit) return [html];
  const parts: string[] = [];
  let rest = html;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit * 0.4) cut = window.lastIndexOf("\n");
    if (cut < limit * 0.4) cut = window.lastIndexOf("> ");
    if (cut < 32) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export function stripButtonBlocksForIMessage(src: string): string {
  return src.replace(BUTTONS, (_, body: string) => {
    return String(body)
      .split("\n")
      .map((line) => {
        const m = line.trim().match(/^\[([^\]]+)\]\((.+)\)$/);
        if (!m) return line.trim();
        const label = m[1]!.replace(/[*_`]+/g, "").trim();
        const dest = m[2]!.trim();
        if (dest.startsWith("callback:")) return label;
        return `${label}\n${dest}`;
      })
      .filter(Boolean)
      .join("\n");
  });
}

export function inlineKeyboard(rows: TelegramButton[][]): {
  inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
} | undefined {
  if (rows.length === 0) return undefined;
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) =>
        b.url
          ? { text: b.text, url: b.url }
          : { text: b.text, callback_data: b.callback_data ?? b.text },
      ),
    ),
  };
}
