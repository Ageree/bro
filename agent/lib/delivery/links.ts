/**
 * The links in the text of a `send_message`. The model writes a link as
 * `[слово](https://…)`; the channels draw it their own way (Telegram as a
 * tappable word, the web chat as Markdown, iMessage as the word and its
 * address, `agent/lib/imessage-text/compile.ts`). Two things are settled
 * here, before any channel sees the text: an address written without its
 * scheme (`mvideo.ru/products/…`, 12.10) gets `https://` and so is a link in
 * every channel, and in a task agent's report turn a link shows its address.
 */

// Only a host that ends in a real web zone is an address: `node.js/docs`,
// `report.pdf/x` or `Привет.Как/дела` are not. A zone outside the list is
// left as the model wrote it, which costs a missing `https://`, not a wrong
// link in the middle of a sentence.
const zones =
  "ru|su|com|net|org|info|biz|io|co|me|tv|ai|app|dev|shop|store|online|site|tech|cloud|xyz|by|kz|ua|uz|ge|am|de|fr|uk|eu|us|it|es|nl|pl|cz|tr|cn|jp|xn--p1ai";
const hostPattern = String.raw`(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${zones})`;
const urlChars = String.raw`[^\s<>()\[\]]`;
const bareAddress = new RegExp(
  String.raw`(?<![\p{L}\p{N}@/.:_-])${hostPattern}(?::\d+)?\/${urlChars}*(?:\(${urlChars}*\)${urlChars}*)*`,
  "giu"
);
const hostLike = new RegExp(
  String.raw`^${hostPattern}(?::\d+)?(?:[/?#]|$)`,
  "iu"
);
const schemePattern = /^[a-z][a-z0-9+.-]*:/iu;
const trailingPunctuation = /[.,;:!?»"']+$/u;
/** Fenced blocks and inline code: what is written there is not a link. */
const codePattern = /(```[\s\S]*?```|`[^`\n]*`)/u;
const markdownLink =
  /(!?)\[([^\]\n]+)\]\(\s*([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\s*\)/gu;

/** Whether a link target is a web address missing only its scheme. */
function missingScheme(target: string) {
  return !schemePattern.test(target) && hostLike.test(target);
}

/**
 * The text with every link target and every bare address given `https://`.
 * Already-schemed targets, relative paths (`/artifacts/…`), images and
 * anything in code are untouched, so the output is idempotent.
 */
export function withHttpsLinks(text: string) {
  return text
    .split(codePattern)
    .map((part, index) => (index % 2 === 1 ? part : prose(part)))
    .join("");
}

function prose(text: string) {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(markdownLink)) {
    out += bareAddresses(text.slice(last, match.index));
    const [whole, bang, label, target] = match;
    out +=
      bang === "" && target !== undefined && missingScheme(target)
        ? `[${label ?? ""}](https://${target})`
        : whole;
    last = match.index + whole.length;
  }
  return out + bareAddresses(text.slice(last));
}

function bareAddresses(text: string) {
  return text.replaceAll(bareAddress, (address) => {
    const punctuation = trailingPunctuation.exec(address)?.[0] ?? "";
    const core = address.slice(0, address.length - punctuation.length);
    return `https://${core}${punctuation}`;
  });
}

// The forms of a Markdown link a report turn must show as text. A target is
// `<…>` or a run without spaces that may hold balanced parentheses; a title
// may follow it.
const target = String.raw`(?:<([^>\n]*)>|([^\s()<]*(?:\([^\s()]*\)[^\s()]*)*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?`;
const imageInLink = new RegExp(
  String.raw`\[\s*!\[([^\]\n]*)\]\([^)\n]*\)\s*\]\(\s*${target}\s*\)`,
  "gu"
);
const inlineLink = new RegExp(
  String.raw`(!?)\[([^\]\n]*)\]\(\s*${target}\s*\)`,
  "gu"
);
const referenceDefinition =
  /^ {0,3}\[([^\]\n]+)\]:[ \t]*<?(\S+?)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*$/gmu;
const referenceLink = /(!?)\[([^\]\n]+)\](?:\[([^\]\n]*)\]|(?![([]))/gu;

function shown(label: string, address: string) {
  const word = label.trim();
  return word === "" || word === address ? address : `${word}: ${address}`;
}

/**
 * The text with every Markdown link and image written as `слово: адрес`, so
 * the person reads where it leads and nothing is fetched for them. A task
 * agent's report may have built the address from the person's files, and a
 * tappable word or an image loaded by the web chat would hide or carry it.
 * Covers inline links, titles, `<…>` targets, an image inside a link and
 * reference links. Private artifact paths (`/artifacts/…`) and what `keep`
 * accepts (the task agent's own shared files) stay as written.
 */
export function withVisibleLinks(
  text: string,
  keep: (url: string) => boolean = () => false
) {
  const own = (address: string) =>
    address.startsWith("/artifacts/") || keep(address);
  const definitions = new Map<string, string>();
  const withoutDefinitions = text.replaceAll(
    referenceDefinition,
    (_whole, key: string, address: string) => {
      definitions.set(key.trim().toLowerCase(), address);
      return "";
    }
  );
  const shownText = withoutDefinitions
    .replaceAll(
      imageInLink,
      (_whole, alt: string, angled?: string, plain?: string) =>
        shown(alt, angled ?? plain ?? "")
    )
    .replaceAll(
      referenceLink,
      (whole, _bang: string, label: string, reference?: string) => {
        const key = (
          reference === undefined || reference === "" ? label : reference
        )
          .trim()
          .toLowerCase();
        const address = definitions.get(key);
        if (address === undefined) return whole;
        return own(address) ? whole : shown(label, address);
      }
    )
    .replaceAll(
      inlineLink,
      (
        whole,
        _bang: string,
        label: string,
        angled?: string,
        plain?: string
      ) => {
        const address = angled ?? plain ?? "";
        return own(address) ? whole : shown(label, address);
      }
    );
  // Only a text that lost a definition line is tidied; the rest goes as is.
  return definitions.size === 0
    ? shownText
    : shownText.replaceAll(/\n{3,}/gu, "\n\n").trim();
}
