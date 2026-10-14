import { env } from "@shared/environment";

/**
 * Whether Bro carries the workspace's errands on by itself
 * (ERRAND_AUTONOMY_WORKSPACES, owner 14.10): after a site never lets the
 * run past its anti-bot check, the free part of the errand goes on at a
 * fallback site with no new word from the person, and fines are checked by
 * an errand on the official ГИБДД site. Named by its id, or everyone with
 * `*`; unset, nobody is, and the instructions read as before. A pure read of
 * the environment: the instructions, the skill bodies and the tool agree.
 */
export function errandAutonomyPilot(workspaceId: string | undefined) {
  const list = env.ERRAND_AUTONOMY_WORKSPACES ?? [];
  return (
    workspaceId !== undefined &&
    (list.includes("*") || list.includes(workspaceId))
  );
}

const latinOf: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "i",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/**
 * A word as its Latin letters, loosely: «Озон» and "ozon", «Авито» and
 * "avito", «Яндекс» and "yandex" read the same. Double letters are one, as
 * the two spellings of a brand rarely agree on them.
 */
function skeleton(word: string) {
  return [...word.toLowerCase()]
    .map((letter) => latinOf[letter] ?? letter)
    .join("")
    .replaceAll("ks", "x")
    .replaceAll("w", "v")
    .replaceAll(/[jy]/gu, "i")
    .replaceAll("kh", "h")
    .replaceAll(/(.)\1+/gu, "$1");
}

/**
 * The words of the person's messages, as their skeletons, for the check of
 * whether they named a site (`namesSite`): what the tool keeps of their
 * recent messages for a turn they did not open, without their text, and
 * without anything that holds a digit: a code or a number never names a
 * shop. Each two words in a row count as one too, for a brand written
 * apart: «Barber One», «Яндекс Маркет».
 */
export function personSiteWords(messages: readonly string[]) {
  const words = new Set<string>();
  for (const message of messages) {
    const said = message.match(/\p{L}+/gu) ?? [];
    for (const [index, word] of said.entries()) {
      if (word.length >= 3) words.add(skeleton(word));
      const next = said[index + 1];
      if (next !== undefined) words.add(skeleton(`${word}${next}`));
    }
  }
  return [...words].toSorted();
}

/**
 * Whether the person's words name the site of the registrable `domain` —
 * «на Озоне», "ozon.ru", «в Авито», «Barber One» for barber-one.ru: its
 * brand, in any ending. A brand shorter than four letters is named only
 * word for word. A site the person named is theirs to change: an errand it
 * never let in goes nowhere else without their word. A brand named in
 * another spelling («Вайлдберриз») is not caught here; the instructions
 * hold the same rule.
 */
export function namesSite(words: readonly string[], domain: string) {
  const brand = skeleton((domain.split(".")[0] ?? "").replaceAll("-", ""));
  if (brand === "") return false;
  return words.some((word) =>
    brand.length < 4 ? word === brand : word.startsWith(brand)
  );
}
