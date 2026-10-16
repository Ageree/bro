import type { SigningPlan } from "@db/services/signatures/signings";

/**
 * Bro's one question before signing, written by code so the model cannot
 * leave out what the person agrees to: the document, each place's pages and
 * printed label, the date, which signature, and that an image of a
 * signature is not a qualified electronic signature. It always ends with
 * «Подписываю?» or "Shall I sign?", the end the person's «да» answers.
 */

type Role = SigningPlan["places"][number]["role"];

const roles: readonly Role[] = ["signature", "initials", "date"];

const words = {
  en: {
    and: "and",
    names: { date: "date", initials: "initials", signature: "signature" },
    page: "p.",
  },
  ru: {
    and: "и",
    names: { date: "дата", initials: "инициалы", signature: "подпись" },
    page: "стр.",
  },
} as const;

/** Words that only name a place's role or the date's format. */
const roleWord =
  /^(?:подпись|подписи|дата|инициалы|signature|date|initials|дд|мм|гггг|dd|mm|yyyy)$/u;

/**
 * Whether a label says more than the place's role: «Подпись · (подпись)»
 * and «Дата · (дд.мм.гггг)» name nothing the question does not, «Подпись
 * наймодателя» and «Наниматель» name whose place it is.
 */
function tellsWhose(label: string) {
  return label
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}]+/u)
    .some((word) => word.length > 0 && !roleWord.test(word));
}

/** «1–4», «1 и 3», «1, 3 и 5»: runs of three or more pages as a range. */
function pageList(pages: readonly number[], and: string) {
  const sorted = [...new Set(pages)].toSorted((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const page of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && page === last[1] + 1) last[1] = page;
    else runs.push([page, page]);
  }
  const items = runs.flatMap(([first, last]) =>
    last - first >= 2
      ? [`${String(first)}–${String(last)}`]
      : first === last
        ? [String(first)]
        : [String(first), String(last)]
  );
  return items.length === 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1) ?? ""}`;
}

function placeList(
  plan: SigningPlan,
  dateText: string,
  language: keyof typeof words
) {
  const { and, names, page } = words[language];
  const [open, close] = language === "ru" ? ["«", "»"] : ['"', '"'];
  return roles
    .flatMap((role) => {
      const places = plan.places.filter((place) => place.role === role);
      if (places.length === 0) return [];
      // Every label: one left out could be the other party's place.
      const labels = [
        ...new Set(
          places.flatMap(({ label }) =>
            label === null || !tellsWhose(label) ? [] : [label]
          )
        ),
      ];
      const named = role === "date" ? `${names.date} ${dateText}` : names[role];
      const pages = pageList(
        places.flatMap((place) => place.pages),
        and
      );
      const quoted =
        labels.length === 0
          ? ""
          : ` (${labels.map((label) => `${open}${label}${close}`).join(", ")})`;
      return [`${named} — ${page} ${pages}${quoted}`];
    })
    .join("; ");
}

export function signingQuestion(input: {
  readonly dateText: string;
  readonly documentName: string;
  readonly formal: boolean;
  readonly language: "en" | "ru";
  readonly plan: SigningPlan;
  readonly signature: {
    readonly kind: "image" | "typed";
    readonly source: "photo" | "saved";
    readonly text?: string;
  };
}) {
  const places = placeList(input.plan, input.dateText, input.language);
  const dated = input.plan.places.some(({ role }) => role === "date");
  const { documentName: name, signature } = input;
  if (input.language === "en") {
    const what =
      signature.source === "photo"
        ? `I'll save the signature from the photo in your message (sample attached) and put it on "${name}"`
        : signature.kind === "typed"
          ? `I'll put your name "${signature.text ?? ""}" in a handwriting font on "${name}"`
          : `I'll put your saved signature on "${name}"`;
    return `${what}: ${places}. This is an image of your signature${dated ? " and a date" : ""}, not a qualified electronic signature. Shall I sign?`;
  }
  const you = input.formal
    ? { own: "вашу", ownName: "ваше", message: "вашего" }
    : { own: "твою", ownName: "твоё", message: "твоего" };
  const what =
    signature.source === "photo"
      ? `Сохраню подпись с фото из ${you.message} сообщения (образец во вложении) и поставлю её на «${name}»`
      : signature.kind === "typed"
        ? `Ставлю ${you.ownName} имя «${signature.text ?? ""}», написанное рукописным шрифтом, на «${name}»`
        : `Ставлю ${you.own} сохранённую подпись на «${name}»`;
  return `${what}: ${places}. Это картинка подписи${dated ? " и дата" : ""}, а не электронная подпись (КЭП). Подписываю?`;
}

/**
 * A message that ends by asking to sign: «…Подписываю?», «Ставлю подпись
 * на заявление?», "Shall I sign?" — not «Подписал. Что-то ещё?», not
 * «Оплачиваю?».
 */
export const signQuestionPattern =
  /(?<!\p{L})(?:подпис\p{L}*|подпиш\p{L}*|sign\p{L}*)(?!\p{L})[^.!?\n]*[?？]\s*$/iu;
