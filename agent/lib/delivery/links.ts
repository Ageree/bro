/**
 * The links in the text of a `send_message`. The model writes a link as
 * `[слово](https://…)`; the channels draw it their own way (Telegram as a
 * tappable word, the web chat as Markdown, iMessage as the word and its
 * address, `agent/lib/imessage-text/compile.ts`). Two things are settled
 * here, before any channel sees the text: an address written without its
 * scheme (`mvideo.ru/products/…`, 12.10) gets `https://` and so is a link in
 * every channel, and in a task agent's report turn a link shows its address.
 */

// A bare address needs a dot-separated host with a letter-only last label and
// a path, so `файл.txt` or `3.5/5` is no address; a path-less `mvideo.ru` is
// left alone for the same reason.
const hostPattern = String.raw`(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}`;
const bareAddress = new RegExp(
  String.raw`(?<![\p{L}\p{N}@/.:_-])${hostPattern}(?::\d+)?\/[^\s<>()\[\]]*(?:\([^\s<>()\[\]]*\)[^\s<>()\[\]]*)*`,
  "gu"
);
const markdownLink =
  /(!?)\[([^\]\n]+)\]\(\s*([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\s*\)/gu;
const schemePattern = /^[a-z][a-z0-9+.-]*:/iu;
const trailingPunctuation = /[.,;:!?»"']+$/u;
const hostLike = new RegExp(
  String.raw`^${hostPattern}(?::\d+)?(?:[/?#]|$)`,
  "u"
);

/** Whether a link target is a web address missing only its scheme. */
function missingScheme(target: string) {
  return !schemePattern.test(target) && hostLike.test(target);
}

/**
 * The text with every link target and every bare address given `https://`.
 * Already-schemed targets, relative paths (`/artifacts/…`) and images are
 * untouched, so the output is idempotent.
 */
export function withHttpsLinks(text: string) {
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

/**
 * The text with every `[слово](https://…)` written as `слово: https://…`, so
 * the person reads where a link leads. A task agent's report may have built
 * the address from the person's files, and a tappable word would hide it.
 * Images (`![…](…)`) and private artifact paths stay as written.
 */
export function withVisibleLinks(text: string) {
  return text.replaceAll(
    markdownLink,
    (whole, bang: string, label: string, target: string) =>
      bang === "" && /^https?:\/\//iu.test(target)
        ? label.trim() === target
          ? target
          : `${label.trim()}: ${target}`
        : whole
  );
}
