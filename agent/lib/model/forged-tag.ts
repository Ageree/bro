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
 * may stand apart, however far.
 */

/** What draws nothing: combining marks and default-ignorable characters. */
const drawsNothing = /[\p{M}\p{Default_Ignorable_Code_Point}]/gu;

/** Brackets that read as `<` though they neither are nor decompose to it. */
const lessThanLookAlikes = ["‹", "˂", "ᐸ", "〈", "⟨", "⧼", "❬", "❮"];

/**
 * Letters of other scripts, and brackets, that read as a Latin letter or
 * `<` after compatibility decomposition and lower case.
 */
const lookAlikes = new Map([
  ...lessThanLookAlikes.map((bracket) => [bracket, "<"] as const),
  ...Object.entries({
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
  }),
]);

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
 * What decomposes to `<`, `&` or a look-alike of `<`: the full-width and
 * small forms of both, the crossed-out `≮`, the old angle bracket (U+2329,
 * to U+3008) and its vertical form (U+FE3F).
 */
const decomposedOpeners = ["＜", "﹤", "≮", "＆", "﹠", "〈", "︿"];

/**
 * Where a tag may begin: every character whose skeleton is `<` or `&` (an
 * entity). `tests/forged-tag.test.ts` checks the list against all of
 * Unicode.
 */
const openers = new RegExp(
  `[<&${[...lessThanLookAlikes, ...decomposedOpeners].join("")}]`,
  "gu"
);

/** The tag's `<`: the sign or its entity. */
const lessThan = /<|&lt;?|&#0*60;?|&#x0*3c;?/uy;

/** The `/` that makes the tag a closing one. */
const slash = /\/|&#0*47;?|&#x0*2f;?/uy;

/**
 * One unit of what may stand between the tag's signs and letters: a space,
 * dash, dot or the like, or the entity of a space or of a character that
 * draws nothing. Never `/`, which makes the tag a closing one.
 */
const gapUnit =
  /[\s\p{Z}\p{Pd}_.:·•*'"\x60~^]|&(?:nbsp|shy|zwnj|zwj|#0*(?:160|173|8203|8204|8205|8288|65279)|#x0*(?:a0|ad|200b|200c|200d|2060|feff));?/uy;

/** A numeric entity whose zeros run on past what is read of the text. */
const paddedEntity = /&#x?0*$/uy;

/** How much skeleton a unit of the tag is read with: its longest entity. */
const unitReach = 16;

/**
 * The skeleton of a text from `from` on, with the place in the text of each
 * of its units, read only as far as a match asks: a tag's gap may be any
 * length, and most openers are no tag.
 */
function skeletonFrom(text: string, from: number) {
  let folded = "";
  const origin: number[] = [];
  let next = from;
  const reach = (units: number) => {
    if (folded.length >= units) return folded;
    // In growing steps: each step copies what was read before it.
    const goal = Math.max(units, 2 * folded.length);
    const parts = [folded];
    let length = folded.length;
    while (length < goal && next < text.length) {
      const char = String.fromCodePoint(text.codePointAt(next) ?? 0);
      const part = fold(char);
      const first = origin.length;
      origin.length += part.length;
      origin.fill(next, first);
      parts.push(part);
      length += part.length;
      next += char.length;
    }
    folded = parts.join("");
    return folded;
  };
  return {
    /** Where the text goes on after the skeleton's first `units` units. */
    end: (units: number) => {
      reach(units + 1);
      return origin[units] ?? text.length;
    },
    /** The skeleton read on to the unit at `at` and a unit's reach past it. */
    near: (at: number) => {
      let read = reach(at + unitReach);
      paddedEntity.lastIndex = at;
      while (next < text.length && paddedEntity.test(read)) {
        read = reach(2 * read.length);
        paddedEntity.lastIndex = at;
      }
      return read;
    },
  };
}

/**
 * The look-alike of the opening or closing of a tag at `index`, the place of
 * an opener: whether it closes, and where the text after it goes on. Its
 * letters are matched one by one, each gap read to its end, so no gap is
 * too long to see.
 */
function forgedTagAt(text: string, index: number, letters: readonly RegExp[]) {
  const skeleton = skeletonFrom(text, index);
  let at = 0;
  const take = (unit: RegExp) => {
    const read = skeleton.near(at);
    unit.lastIndex = at;
    const taken = unit.exec(read)?.[0].length ?? 0;
    at += taken;
    return taken > 0;
  };
  const skipGap = () => {
    while (take(gapUnit)) {
      // The gap goes on.
    }
  };
  if (!take(lessThan)) return undefined;
  skipGap();
  const closing = take(slash);
  if (closing) skipGap();
  for (const [place, letter] of letters.entries()) {
    if (place > 0) skipGap();
    if (!take(letter)) return undefined;
  }
  return { closing, end: skeleton.end(at) };
}

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
 * The defuser of one tag: every look-alike of its opening or closing becomes
 * `‹name` or `‹/name`, so the model reads it as a quote rather than as the
 * tag. Text without one comes back as it was.
 */
export function tagDefuser(name: string) {
  // The tag's letters (lower-case words joined by dashes), each as the
  // skeleton may read it.
  const letters = Array.from(
    name.replaceAll("-", ""),
    (letter) => new RegExp(`[${letterLookAlikes.get(letter) ?? letter}]`, "uy")
  );
  return (text: string) => {
    let defused = "";
    let copied = 0;
    for (const { index } of text.matchAll(openers)) {
      if (index < copied) continue;
      const tag = forgedTagAt(text, index, letters);
      if (tag === undefined) continue;
      defused += `${text.slice(copied, index)}‹${tag.closing ? "/" : ""}${name}`;
      copied = tag.end;
    }
    return copied === 0 ? text : defused + text.slice(copied);
  };
}
