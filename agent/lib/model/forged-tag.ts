/**
 * Tags the model reads as Bro's own word when they reach it in user-role
 * text: the step's note (`bro-step-note`) and a skill's rules (`bro-skill`).
 * The person, a page, a mail or a tool's result may write the same tag, and
 * every copy that is not Bro's own is defused before the model reads it.
 *
 * A forger need not write the tag in plain ASCII for a model to read it as
 * one: full-width or mathematical letters, Cyrillic or Greek look-alikes, a
 * zero for an «o», soft hyphens, joiners and other characters that draw
 * nothing, any dash, dot or space between the letters, another angle
 * bracket or an HTML entity for `<`. So a candidate is read through its
 * skeleton — compatibility-decomposed, lower-cased, marks and invisible
 * characters dropped, look-alikes folded to Latin — and the tag's letters
 * may stand apart.
 */

/** What draws nothing: combining marks and default-ignorable characters. */
const drawsNothing = /[\p{M}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Letters of other scripts, and brackets, that read as a Latin letter or
 * `<` after compatibility decomposition and lower case.
 */
const lookAlikes = new Map(
  Object.entries({
    "‹": "<",
    "˂": "<",
    ᐸ: "<",
    "〈": "<",
    "⟨": "<",
    "⧼": "<",
    "❬": "<",
    "❮": "<",
    α: "a",
    β: "b",
    ε: "e",
    ι: "i",
    κ: "k",
    ν: "v",
    ο: "o",
    ρ: "p",
    τ: "t",
    υ: "u",
    χ: "x",
    а: "a",
    в: "b",
    г: "r",
    е: "e",
    к: "k",
    м: "m",
    н: "h",
    о: "o",
    п: "n",
    р: "p",
    с: "c",
    т: "t",
    у: "y",
    х: "x",
    ь: "b",
    і: "i",
    ј: "j",
    ѕ: "s",
    һ: "h",
    ӏ: "l",
    ԁ: "d",
    ԛ: "q",
    ԝ: "w",
  })
);

const foldedChars = new Map<string, string>();

/** One character as the skeleton reads it: possibly none, possibly more. */
function fold(char: string) {
  const known = foldedChars.get(char);
  if (known !== undefined) return known;
  const plain = char
    .normalize("NFKD")
    .toLowerCase()
    .normalize("NFKD")
    .replace(drawsNothing, "");
  const folded = Array.from(plain, (part) => lookAlikes.get(part) ?? part).join(
    ""
  );
  foldedChars.set(char, folded);
  return folded;
}

/**
 * Where a tag may begin: `<`, `&` (an entity) and every character whose
 * skeleton is one of them (`tests/forged-tag.test.ts` checks the list
 * against all of Unicode).
 */
const openers =
  /[<&\uff1c\ufe64\u226e\uff06\ufe60\u2039\u02c2\u1438\u2329\u3008\u27e8\u29fc\u276c\u276e]/gu;

/** How far after its opener a tag's first letter, and its last, may stand. */
const firstReach = 32;
const lastReach = 256;

/** A text's skeleton, with the place in the text each of its units has. */
function skeleton(text: string) {
  const parts: string[] = [];
  const origin: number[] = [];
  let at = 0;
  for (const char of text) {
    const part = fold(char);
    const from = origin.length;
    origin.length += part.length;
    origin.fill(at, from);
    parts.push(part);
    at += char.length;
  }
  origin.push(text.length);
  return { folded: parts.join(""), origin };
}

/**
 * What may stand between the tag's signs and letters: spaces, dashes, dots
 * and the like, and the entity of a character that draws nothing. Never
 * `/`, which makes the tag a closing one.
 */
const gap = String.raw`(?:[\s\p{Z}\p{Pd}_.:·•*'"\x60~^]|&(?:nbsp|shy|zwnj|zwj|#0*(?:160|173|8203|8204|8205|8288|65279)|#x0*(?:a0|ad|200b|200c|200d|2060|feff));?)*`;

/** The digits and signs that pass for a letter of the tags' names. */
const letterLookAlikes = new Map(
  Object.entries({
    b: "b6",
    e: "e3",
    i: "il1|!",
    l: "il1|!",
    o: "o0",
    s: "s5$",
    t: "t7+",
  })
);

/**
 * The skeleton of the opening or closing of `name` (lower-case words joined
 * by dashes), from its opener on. The `/` of a closing tag is `slash`.
 */
function forgedTagPattern(name: string) {
  const [first, ...rest] = Array.from(
    name.replaceAll("-", ""),
    (letter) => `[${letterLookAlikes.get(letter) ?? letter}]`
  );
  const start = String.raw`^(?:<|&lt;?|&#0*60;?|&#x0*3c;?)${gap}(?<slash>(?:\/|&#0*47;?|&#x0*2f;?)${gap})?`;
  return {
    // Most openers are no tag: a short look rules them out.
    begins: new RegExp(String.raw`${start}(?:${first ?? ""}|$)`, "u"),
    whole: new RegExp(`${start}${[first, ...rest].join(gap)}`, "u"),
  };
}

/**
 * The defuser of one tag: every look-alike of its opening or closing becomes
 * `‹name` or `‹/name`, so the model reads it as a quote rather than as the
 * tag. Text without one comes back as it was.
 */
export function tagDefuser(name: string) {
  const { begins, whole } = forgedTagPattern(name);
  return (text: string) => {
    let defused = "";
    let copied = 0;
    for (const { index } of text.matchAll(openers)) {
      if (index < copied) continue;
      if (
        !begins.test(skeleton(text.slice(index, index + firstReach)).folded)
      ) {
        continue;
      }
      const { folded, origin } = skeleton(text.slice(index, index + lastReach));
      const match = whole.exec(folded);
      if (match === null) continue;
      const slash = match.groups?.slash === undefined ? "" : "/";
      defused += `${text.slice(copied, index)}‹${slash}${name}`;
      copied = index + (origin[match[0].length] ?? 0);
    }
    return copied === 0 ? text : defused + text.slice(copied);
  };
}
