/** Model markdown → Telegram HTML. Cyrillic bold/italic work natively.
 *  MarkdownV2 is not used — escaping it breaks Russian and URLs. */

export const TELEGRAM_TEXT_LIMIT = 4096;

const FENCE = /```([\w+-]*)\n?([\s\S]*?)```/g;
const BUTTONS = /:::buttons\s*\n([\s\S]*?):::/g;
const IMAGE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+|callback:[^)\s]+)\)/gi;
const AUTO_URL = /<(https?:\/\/[^>\s]+)>/gi;
const AUTO_MAIL = /<([^>\s]+@[^>\s]+)>/g;

export type TelegramButton = {
  text: string;
  url?: string;
  callback_data?: string;
};

export type TelegramCompiled = {
  html: string;
  chunks: string[];
  buttons: TelegramButton[][];
  photos: string[];
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

function applyMarkdown(escaped: string): string {
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
  s = s.replace(/^#{1,6}\s+(.*)$/gm, (_, t: string) => `<b>${t.trim()}</b>`);
  s = s.replace(/^&gt;\s?(.*)$/gm, (_, t: string) => `<blockquote>${t}</blockquote>`);
  s = s.replace(/^\s*[-*]\s+/gm, "• ");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<b><i>$1</i></b>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_]+)__/g, "<b>$1</b>");
  s = s.replace(
    /(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g,
    (_, a: string, t: string) => `${a}<i>${t}</i>`,
  );
  s = s.replace(/\*\*/g, "");
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toTelegramHtml(src: string): string {
  return compileTelegram(src).html;
}

export function compileTelegram(src: string): TelegramCompiled {
  let s = src.replace(/\r\n/g, "\n");
  const { text, buttons } = extractButtons(s);
  s = text;

  const photos: string[] = [];
  s = s.replace(IMAGE, (_, _alt: string, url: string) => {
    photos.push(String(url).trim());
    return "";
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

  s = applyMarkdown(escapeHtml(s));
  s = s.replace(/\u0000F(\d+)\u0000/g, (_, i: string) => fences[Number(i)] ?? "");
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  return {
    html: s,
    chunks: splitTelegramHtml(s),
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
