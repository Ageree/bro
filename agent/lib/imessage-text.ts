/** iMessage does not render markdown. Convert model output to readable bubbles.
 *  Inkbox cannot send iOS 18 text styles. Latin/digits **bold** become
 *  Mathematical Sans-Serif Bold (looks bold on iPhone). Cyrillic field
 *  labels get a leading ▸ — mixed-script fake-bold looks broken. */

const FENCE = /```[\w+-]*\n?([\s\S]*?)```/g;
const IMAGE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
const AUTO_URL = /<(https?:\/\/[^>\s]+)>/gi;
const AUTO_MAIL = /<([^>\s]+@[^>\s]+)>/g;
const LABEL =
  /^(?:(\d+\.\s*))?(От|Тема|Дата|Предварительный текст|From|Subject|Date|To|Preview)\s*:/u;

function collapse(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function styledChar(
  ch: string,
  upper: number,
  lower: number,
  digit: number | null,
): string | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if (cp >= 65 && cp <= 90) return String.fromCodePoint(upper + (cp - 65));
  if (cp >= 97 && cp <= 122) return String.fromCodePoint(lower + (cp - 97));
  if (digit !== null && cp >= 48 && cp <= 57) {
    return String.fromCodePoint(digit + (cp - 48));
  }
  return null;
}

/** Sans-serif math bold. Only when every letter/digit in `s` maps — no 𝗢т. */
export function toBold(s: string): string {
  let out = "";
  let letters = 0;
  let mapped = 0;
  for (const ch of s) {
    if (/\p{L}|\p{N}/u.test(ch)) letters++;
    const b = styledChar(ch, 0x1d5d4, 0x1d5ee, 0x1d7ec);
    if (b) {
      out += b;
      mapped++;
    } else out += ch;
  }
  if (mapped === 0 || mapped < letters) return s;
  return out;
}

export function toItalic(s: string): string {
  let out = "";
  let letters = 0;
  let mapped = 0;
  for (const ch of s) {
    if (/\p{L}|\p{N}/u.test(ch)) letters++;
    const b = styledChar(ch, 0x1d608, 0x1d622, null);
    if (b) {
      out += b;
      mapped++;
    } else out += ch;
  }
  if (mapped === 0 || mapped < letters) return s;
  return out;
}

function strike(s: string): string {
  return [...s].map((ch) => (ch === " " ? ch : ch + "\u0336")).join("");
}

function emphasizeLabels(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      const m = line.match(LABEL);
      if (!m) return line;
      const label = m[2];
      const fancy = toBold(label);
      if (fancy !== label) return line.replace(label, fancy);
      const prefix = m[1] ?? "";
      if (line.slice(prefix.length).startsWith("▸ ")) return line;
      return `${prefix}▸ ${line.slice(prefix.length)}`;
    })
    .join("\n");
}

export function toIMessageText(src: string): string {
  let s = src.replace(/\r\n/g, "\n");

  s = s.replace(FENCE, (_, body: string) => body.replace(/\n+$/, "\n"));
  s = s.replace(IMAGE, (_, alt: string, url: string) => {
    const a = String(alt).replace(/\*+/g, "").trim();
    return a ? `${a}\n${url}` : url;
  });
  s = s.replace(LINK, (_, label: string, url: string) => {
    const l = String(label).replace(/[*_`]+/g, "").trim();
    const u = String(url).trim();
    if (!l || l === u) return u;
    return `${l}\n${u}`;
  });
  s = s.replace(AUTO_URL, "$1");
  s = s.replace(AUTO_MAIL, "$1");

  s = s.replace(/^#{1,6}\s+(.*)$/gm, (_, t: string) => toBold(t.trim()));
  s = s.replace(/^>\s?/gm, "");
  s = s.replace(/^\s*[-*]\s+/gm, "• ");

  s = s.replace(/~~([^~\n]+)~~/g, (_, t: string) => strike(t));
  s = s.replace(/`([^`\n]+)`/g, "$1");
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, (_, t: string) => toBold(t));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t: string) => toBold(t));
  s = s.replace(/__([^_]+)__/g, (_, t: string) => toBold(t));
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, (_, a: string, t: string) =>
    a + toItalic(t),
  );
  s = s.replace(/\*\*/g, "");

  return emphasizeLabels(collapse(s));
}

/** Long numbered dumps (Gmail, products) become one bubble per item. */
export function toIMessageBubbles(src: string): string[] {
  const text = toIMessageText(src);
  if (!text) return [];
  const chunks = text
    .split(/\n(?=\d+\.\s)/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length < 2) return [text];
  const items = chunks[0].match(/^\d+\.\s/) ? chunks : chunks.slice(1);
  const long = items.filter((p) => p.length >= 80);
  if (long.length < 2) return [text];
  return chunks.slice(0, 8);
}

export function isAudioContentType(
  contentType: string | null | undefined,
): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("audio/");
}

/** Voice note for the model. Webhook has no transcript field — use `content` when present. */
export function inboundVoiceLine(opts: {
  content?: string | null;
  url?: string | null;
}): string {
  const transcript = opts.content?.trim();
  if (transcript) return `[voice] ${transcript}`;
  const url = opts.url?.trim();
  if (url) return `[voice message] ${url}`;
  return "";
}

export function inboundIMessageText(msg: {
  content?: string | null;
  media?: Array<{ url?: string | null; content_type?: string | null }> | null;
  message_type?: string | null;
}): string {
  const parts: string[] = [];
  const content = msg.content?.trim();
  const media = msg.media ?? [];
  const audio = media.filter((m) => isAudioContentType(m.content_type));
  if (audio.length > 0) {
    if (content) parts.push(inboundVoiceLine({ content }));
    else {
      for (const m of audio) {
        const line = inboundVoiceLine({ url: m.url });
        if (line) parts.push(line);
      }
    }
  } else if (content) {
    parts.push(content);
  }
  for (const m of media) {
    if (isAudioContentType(m.content_type)) continue;
    const url = m.url?.trim();
    if (url) parts.push(url);
  }
  if (msg.message_type === "carousel" && parts.length === 0) {
    return "[carousel]";
  }
  return parts.join("\n").trim();
}
