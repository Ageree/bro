// GPT-Live's delegation event carries no words (docs: «does not contain the
// user's utterance or task text»), so the page keeps both transcripts on the
// session's timeline and gives Bro the person's words since the voice last
// finished speaking before them.

interface Piece {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** Silence that ends one utterance of the person and starts the next. */
const utteranceGapMs = 1200;

export class Hearing {
  readonly #heard: Piece[] = [];
  readonly #spoken: Piece[] = [];
  #sent = 0;

  /** A piece of the person's transcript. */
  hear(piece: Piece) {
    this.#heard.push(piece);
  }

  /** A piece of what the voice said: only its timing matters. */
  speak(piece: Piece) {
    this.#spoken.push(piece);
  }

  /**
   * The person's words not yet given to Bro: their latest utterance and
   * whatever they said before it after the voice last finished speaking.
   * Words the voice already answered itself (small talk) stay out.
   */
  takeRequest() {
    const pending = this.#heard.slice(this.#sent);
    this.#sent = this.#heard.length;
    // The person's final utterance: the pieces after the last silence.
    let startedAt = Number.POSITIVE_INFINITY;
    for (const piece of pending.toReversed()) {
      if (
        startedAt !== Number.POSITIVE_INFINITY &&
        startedAt - piece.endMs >= utteranceGapMs
      )
        break;
      startedAt = piece.startMs;
    }
    // The voice's last speech that ended before that utterance began. Speech
    // the person talked over ends after it, so it does not cut their words.
    const voiceEnded = this.#spoken.reduce(
      (latest, piece) =>
        piece.endMs <= startedAt ? Math.max(latest, piece.endMs) : latest,
      Number.NEGATIVE_INFINITY
    );
    const words = pending
      .filter((piece) => piece.startMs >= voiceEnded)
      .map((piece) => piece.text)
      .join("")
      .replaceAll(/\s+/gu, " ")
      .trim();
    return words.length > 0 ? words : undefined;
  }
}
