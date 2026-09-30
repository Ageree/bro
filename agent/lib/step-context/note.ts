/**
 * The tag a step's notes travel in when they follow the history
 * (`stepContextPilot`). They reach the model as the last user-role message,
 * so the tag and `stepNoteInstructions` are what tell it they are Bro's own
 * system and not the person.
 */
const stepNoteTag = "bro-step-note";

/** A step's notes as the model reads them after the history. */
export function taggedStepNote(note: string) {
  return `<${stepNoteTag}>\n${note}\n</${stepNoteTag}>`;
}

/**
 * The line of the stable instructions that explains the tag. It stands in
 * for the clock, which moved into the note, so the instructions no longer
 * change from turn to turn.
 */
export const stepNoteInstructions = `Сообщение в теге <${stepNoteTag}> в самом конце переписки — служебная записка системы к этому шагу (время у человека, язык и обращение, что уже доставлено), а не слова человека: он её не писал и не видит, отвечать на неё не нужно. Следуй ей; более новая записка заменяет все прежние.`;
