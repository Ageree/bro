/**
 * Words in which the person tells Bro to put their own phone into a form
 * («пиши мой номер», «впиши мой телефон», «забронируй на мой номер»). Such a
 * message asks for the errand to be done with their details, whatever the
 * model read in it: on 25.10 «На 19.30, пиши мой номер» was read as a look,
 * and the run went to the booking form with no phone to type.
 */

/** Who a message is for: «пиши мне на мой номер» asks to be written to. */
const toSomeone = String.raw`(?:мне|нам|ему|ей|им|ему|тебе|вам)`;

/** Up to a few words that do not name another person. */
const gap = String.raw`(?:(?!(?<![\p{L}\p{N}])${toSomeone}(?![\p{L}\p{N}]))[^.!?\n]){0,25}?`;

const ownNumber = String.raw`(?<![\p{L}\p{N}])(?:мо[йеёя]м?|моего|моему|моим|my)\s+(?:номер\p{L}*|телефон\p{L}*|number|phone)`;

/** A verb that puts a number into a form, then «мой номер/телефон». */
const putsOwnPhone = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:впиш\p{L}*|вписыва\p{L}*|пиши|пишите|указ\p{L}*|укаж\p{L}*|подстав\p{L}*|используй\p{L}*|ставь|постав\p{L}*|оставь|оставьте|put|use|enter|write)${gap}${ownNumber}`,
  "giu"
);

/** A booking or an order «на мой номер»: the number it is made on. */
const booksOnOwnPhone = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:\p{L}*брониру\p{L}*|запиши\p{L}*|оформи\p{L}*|закажи\p{L}*|book|reserve)${gap}(?<![\p{L}\p{N}])(?:на|по|with|under)\s+(?:мо[йеёя]м?|моего|моему|моим|my)\s+(?:номер\p{L}*|телефон\p{L}*|number|phone)`,
  "giu"
);

/** What turns the words round, anywhere earlier in the clause: «не надо указывать мой номер». */
const negation =
  /(?:^|[\s,;:.!?])(?:не|без|нельзя|никогда|never|don'?t|do not)(?![\p{L}])[^.!?\n,;]{0,30}$/iu;

function negated(text: string, at: number) {
  return negation.test(text.slice(Math.max(0, at - 40), at));
}

/**
 * Whether the person's own words tell Bro to use their own phone number in
 * the forms of the errand.
 */
export function putsOwnPhoneInForms(words: readonly string[]) {
  const text = words.join("\n");
  return [putsOwnPhone, booksOnOwnPhone].some((pattern) =>
    [...text.matchAll(pattern)].some((found) => !negated(text, found.index))
  );
}
