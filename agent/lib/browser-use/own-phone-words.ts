/**
 * Words in which the person tells Bro to put their own phone into a form
 * («пиши мой номер», «впиши мой телефон», «мой номер +7 921…»). Such a message
 * asks for the errand to be done with their details, whatever the model read
 * in it: on 25.10 «На 19.30, пиши мой номер» was read as a look, and the run
 * went to the booking form with no phone to type.
 */

/** A verb that puts a number into something, then up to a few words, then «мой номер/телефон». */
const putsOwnPhone = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:впиш\p{L}*|вписыва\p{L}*|пиш\p{L}*|указ\p{L}*|укаж\p{L}*|подстав\p{L}*|используй\p{L}*|ставь|постав\p{L}*|оставь\p{L}*|оставля\p{L}*|давай|дай|дава\p{L}*|put|use|enter|write)[^.!?\n]{0,25}?(?<![\p{L}\p{N}])(?:мо[йеёя]м?|моего|моему|моим|my)\s+(?:номер\p{L}*|телефон\p{L}*|number|phone)`,
  "giu"
);

/** «Мой номер +7…»: the number comes with the words. */
const givesOwnPhone = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:мо[йеёя]м?|моего|my)\s+(?:номер\p{L}*|телефон\p{L}*|number|phone)(?:\s+(?:такой|is|—|-))?\s*[:\-]?\s*[+(]?\d`,
  "giu"
);

/** What turns the words round: «не пиши мой номер», «без моего номера». */
const negation =
  /(?:^|[\s,;:.!?])(?:не|без|нельзя|никогда|never|don'?t|do not)\s*$/iu;

function negated(text: string, at: number) {
  return negation.test(text.slice(Math.max(0, at - 14), at));
}

/** Whether the person's own words tell Bro to use their own phone number. */
export function putsOwnPhoneInForms(words: readonly string[]) {
  const text = words.join("\n");
  return [putsOwnPhone, givesOwnPhone].some((pattern) =>
    [...text.matchAll(pattern)].some((found) => !negated(text, found.index))
  );
}
