import { voiceLine } from "@shared/voice/marker";

// GPT-Live's delegation event carries no words (docs: «does not contain the
// user's utterance or task text»), so the page keeps both transcripts on the
// session's timeline and gives Bro what the person said since the last
// request, with the voice's own lines between their words: «Напомни мне
// завтра» — «О чём напомнить?» — «Позвонить маме» is one request.

interface Piece {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface Utterance {
  readonly by: "person" | "voice";
  readonly text: string;
  readonly startMs: number;
}

/** A question the quick answer took and what the voice was given to say. */
export interface QuickAnswer {
  readonly words: string;
  readonly answer: string;
}

/** Silence that ends one utterance and starts the next. */
const utteranceGapMs = 1200;
/** The person's utterances a request carries at most: older talk stays out. */
const keptUtterances = 4;
/** Quick answers the next words to Bro carry at most. */
const keptQuickAnswers = 2;
/** Of Bro's last message, what the quick answer reads. */
const broSaidChars = 400;

export class Hearing {
  readonly #heard: Piece[] = [];
  readonly #spoken: Piece[] = [];
  #sent = 0;

  /** A piece of the person's transcript. */
  hear(piece: Piece) {
    this.#heard.push(piece);
  }

  /** A piece of what the voice said. */
  speak(piece: Piece) {
    this.#spoken.push(piece);
  }

  /** Whether some of the person's words have not been given to Bro yet. */
  hasRequest() {
    return this.#heard.length > this.#sent;
  }

  /**
   * The person's words not yet given to Bro, their last few utterances, with
   * the voice's lines between them (`voiceLine`, which the web channel
   * explains to the model). The voice's line after their last words
   * («Сейчас гляну») is not part of the request.
   */
  takeRequest() {
    const pending = this.#heard.slice(this.#sent);
    this.#sent = this.#heard.length;
    const person = utterances(pending, "person").slice(-keptUtterances);
    const first = person[0];
    const last = person.at(-1);
    if (first === undefined || last === undefined) return undefined;
    const voice = utterances(
      this.#spoken.filter(
        (piece) => piece.startMs > first.startMs && piece.startMs < last.startMs
      ),
      "voice"
    );
    return [...person, ...voice]
      .toSorted((a, b) => a.startMs - b.startMs)
      .map((line) => (line.by === "person" ? line.text : voiceLine(line.text)))
      .join("\n");
  }
}

/** Text as one line: a voice line must be one, or its readers lose it. */
function oneLine(text: string) {
  return text.replaceAll(/\s+/gu, " ").trim();
}

/**
 * The words going to Bro after the quick answers the voice gave since Bro last
 * heard from the page (VOICE_QUICK_WORKSPACES): Bro never saw those turns, and
 * «напомни утром взять зонт, если так» after the weather would reach it bare.
 * Each goes as one voice line, never as the person's words: a «да» to Bro's
 * «Оплачиваю?» after the weather must still be nothing but «да» to the readers
 * of consent (`spokenWords`), and Bro must not answer the weather again.
 */
export function withQuickAnswers(
  words: string,
  answered: readonly QuickAnswer[]
) {
  return [
    ...answered
      .slice(-keptQuickAnswers)
      .map((quick) =>
        voiceLine(
          `уже ответил голосом на «${oneLine(quick.words)}»: ${oneLine(quick.answer)}`
        )
      ),
    words,
  ].join("\n");
}

/**
 * What the quick answer reads: the person's words after its own earlier
 * answers and Bro's last message, as voice lines, so «а какая там погода?»
 * after Bro wrote of Sochi is Sochi's, and «ну что, нашёл?» is Bro's work.
 */
export function forQuickAnswer(
  words: string,
  answered: readonly QuickAnswer[],
  broSaid: string | undefined
) {
  const said =
    broSaid === undefined
      ? []
      : [voiceLine(oneLine(broSaid).slice(0, broSaidChars))];
  return [...said, withQuickAnswers(words, answered)].join("\n");
}

function utterances(pieces: readonly Piece[], by: Utterance["by"]) {
  const grouped: { text: string; startMs: number; endMs: number }[] = [];
  for (const piece of pieces) {
    const open = grouped.at(-1);
    if (open !== undefined && piece.startMs - open.endMs < utteranceGapMs) {
      open.text += piece.text;
      open.endMs = Math.max(open.endMs, piece.endMs);
    } else grouped.push({ ...piece });
  }
  return grouped
    .map((group): Utterance => ({
      by,
      startMs: group.startMs,
      text: group.text.replaceAll(/\s+/gu, " ").trim(),
    }))
    .filter((line) => line.text.length > 0);
}
