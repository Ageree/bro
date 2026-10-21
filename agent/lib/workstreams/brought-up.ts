/**
 * Which work from the person's other conversations a conversation may be
 * shown (`agent/memory/workstreams.ts`). 21.10, prod: in a new chat the
 * index listed «Заявка на Product Radar» as `active`, and to «👍», «ты
 * дурак», «ыврапролджэ» and «спасибо» Bro answered with that work: promised
 * to fix the application's name, read its record and started a browser
 * errand on the real application. The rule «never continue it here unless
 * the user brings it up» stood in the index and was not held, so the title
 * itself stays out of a conversation until the person's words reach for it.
 */

/** Words that pick work up again, whichever it was: «продолжим», "where were we". */
const continuation = new RegExp(
  [
    String.raw`продолж|возобнов|вернёмся|вернемся|остановились`,
    String.raw`как там|что там|ну что|что с (ним|ней|ними|тем|той|теми)`,
    String.raw`статус|прошлый раз|в прошлый|вчера|начатое|недоделан`,
    String.raw`continue|resume|pick up|carry on|where were we|left off`,
    String.raw`last time|earlier|yesterday|status`,
  ]
    .map((alternative) => `(?<![\\p{L}\\p{N}_])(?:${alternative})`)
    .join("|"),
  "iu"
);

/**
 * Words too common to tie a message to a title: a title that says «with»
 * would otherwise be reached by every sentence that does.
 */
const commonWords = new Set([
  "about",
  "also",
  "have",
  "into",
  "just",
  "more",
  "only",
  "over",
  "some",
  "than",
  "that",
  "them",
  "then",
  "they",
  "this",
  "what",
  "when",
  "where",
  "will",
  "with",
  "your",
  "ваша",
  "ваше",
  "еще",
  "очень",
  "между",
  "можно",
  "надо",
  "нужно",
  "перед",
  "после",
  "потом",
  "просто",
  "свою",
  "тоже",
  "только",
  "через",
  "чтобы",
  "этого",
  "этой",
  "этот",
]);

function fold(text: string) {
  return text.toLowerCase().replaceAll("ё", "е");
}

/** The words of a text that carry a meaning: four letters or more. */
function wordsOf(text: string) {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => word.length >= 4 && /\p{L}/u.test(word)
  );
}

/**
 * A word without its ending: five letters of a long word, one less than
 * itself of a short one («заявка», «заявку» → «заявк»; «радар», «радаре» →
 * «рада»).
 */
function stemOf(word: string) {
  return word.slice(0, word.length > 5 ? 5 : Math.max(4, word.length - 1));
}

/**
 * The work among `elsewhere` the person's words bring up: all of it when
 * they ask to continue or ask for news («ну что там?», "where were we"),
 * else the pieces whose title or id shares a word with them. `said` is
 * everything they wrote in the conversation (`personMessages`), so once work
 * is brought up it stays in the index: the index changes text only the one
 * time, and the conversation's cache goes with it.
 */
export function broughtUpWork<
  T extends { readonly id: string; readonly title?: string | undefined },
>(said: readonly string[], elsewhere: readonly T[]) {
  const text = said.join("\n");
  if (elsewhere.length === 0 || text.trim() === "") return [];
  if (continuation.test(text)) return [...elsewhere];
  const words = wordsOf(text);
  return elsewhere.filter((work) =>
    wordsOf(`${work.title ?? ""} ${work.id.replaceAll("-", " ")}`)
      .filter((word) => !commonWords.has(word))
      .map(stemOf)
      .some((stem) => words.some((word) => word.startsWith(stem)))
  );
}
