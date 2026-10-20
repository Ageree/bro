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

export function replyCommentary(message: string) {
  return `Результат по делу — это сообщение уже ушло человеку в чат от твоего имени: «${spokenText(message)}». Перескажи его вслух коротко своими словами. Если это лишь «уже занимаюсь» или «скоро пришлю», вслух этого не повторяй: ты уже сказал, что занялся.`;
}

export const unheardCommentary =
  "Я не расслышал, что именно сделать: переспроси человека одной короткой фразой.";

export const alreadySentCommentary =
  "Эти слова уже переданы, результат придёт сам: человека не переспрашивай.";

export const waitingCommentary =
  "Чтобы продолжить, человеку нужно нажать кнопку или войти по ссылке в чате: скажи ему открыть чат.";

export const failedCommentary =
  "Дело не получилось, ответа нет. Коротко скажи человеку, что не вышло, и предложи попробовать ещё раз.";

export const unsentCommentary =
  "Просьбу не удалось передать: связь с сервером оборвалась. Скажи человеку, что не получилось, и предложи повторить.";
