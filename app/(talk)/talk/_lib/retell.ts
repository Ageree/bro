// What the voice gets back from Bro through `session.commentary.append`: a
// plain line it retells aloud (500 tokens at most per append).

const maximumLength = 1200;

/** Bro's chat message as words: no markdown, no pictures, no addresses. */
export function spokenText(message: string) {
  const plain = message
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replaceAll(/https?:\/\/\S+/gu, "(ссылка в чате)")
    .replaceAll(/[*_`#>]+/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return plain.length > maximumLength
    ? `${plain.slice(0, maximumLength)}… (дальше — в чате)`
    : plain;
}

/**
 * Bro's message asks the person something («Что берём?» in the middle of a
 * list): their next words are the answer, whether or not the voice hands
 * them over itself.
 */
export function asksPerson(message: string) {
  return spokenText(message).includes("?");
}

/**
 * The fast voice's line the moment it hands a request over (VOICE_FAST_WORKSPACES):
 * it cancels GPT-Live's own acknowledgement, which was «Секунду, смотрю», and
 * the voice names what it looks at in the person's words — «Смотрю, какая
 * завтра погода в Москве.» (probe 27.10: 12 of 12, no filler, no guess).
 */
export const progressCommentary =
  "Дело ещё идёт, результата пока нет. Скажи одной короткой фразой, что именно сейчас смотришь или делаешь, словами просьбы человека. Не проси подождать и не называй результат.";

export function replyCommentary(message: string) {
  return `Результат по делу — это сообщение уже ушло человеку в чат от твоего имени: «${spokenText(message)}». Перескажи его вслух коротко своими словами. Если это лишь «уже занимаюсь» или «скоро пришлю», вслух этого не повторяй: ты уже сказал, что занялся.`;
}

export const unheardCommentary =
  "Я не расслышал, что именно сделать: переспроси человека одной короткой фразой.";

export const alreadySentCommentary =
  "Эти слова уже переданы, результат придёт сам: человека не переспрашивай.";

/** A delegation for words the quick answer already answered. */
export const quickGivenCommentary =
  "Ответ на эти слова ты уже получил и сказал: не повторяй его и не переспрашивай.";

export const waitingCommentary =
  "Чтобы продолжить, человеку нужно нажать кнопку или войти по ссылке в чате: скажи ему открыть чат.";

export const failedCommentary =
  "Дело не получилось, ответа нет. Коротко скажи человеку, что не вышло, и предложи попробовать ещё раз.";

export const unsentCommentary =
  "Просьбу не удалось передать: связь с сервером оборвалась. Скажи человеку, что не получилось, и предложи повторить.";

/**
 * A note for the voice's context (`session.thinking.append`, 500 tokens at
 * most) in pieces of whole lines, each well under that: calendar lines are
 * mostly digits, near two characters a token, and the person's week is longer
 * than one append.
 */
export function notePieces(text: string, limit = 500) {
  const pieces: string[] = [];
  let piece = "";
  for (const line of text.split("\n")) {
    const next = piece === "" ? line : `${piece}\n${line}`;
    if (next.length > limit && piece !== "") {
      pieces.push(piece);
      piece = line.slice(0, limit);
    } else piece = next.slice(0, limit);
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}
