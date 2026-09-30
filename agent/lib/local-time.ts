/**
 * Which kinds of turn know the person's clock, and whether they may save
 * the person's time zone. Bro's own checks read the clock but have no profile
 * to write to, and neither does a report turn, which still has to say
 * «завтра в 07:05» and «выйти в 04:30» on the person's clock rather than UTC.
 */
export const clockModes = {
  interactive: true,
  "proactive-worker": false,
  "scheduled-report": false,
  "scheduled-worker": true,
} as const;

/**
 * What time it is where the person is. Without it the model dates «сегодня»
 * and «завтра» from whatever it guesses, and every schedule, delivery window
 * and «во сколько» it derives from that guess is wrong by a working day.
 */
export function localClock(now: Date, timeZone: string) {
  const localTime = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(now);
  return `Сейчас у человека ${localTime} (таймзона ${timeZone}). Считай «сегодня», «завтра» и «на выходных» от этого времени, а не от чего-то своего.`;
}

/** How a turn that may save the time zone is told to. */
export const saveTimeZoneInstruction =
  "Если он называет город или таймзону, а в Personal Info её нет или она другая — сохрани поле `timezone` через `personal_info__update` именем зоны IANA, например Europe/Moscow.";
