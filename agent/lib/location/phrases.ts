import { stems } from "@agent/lib/skills/triggers";

/**
 * What a place after «приду в/на/к» must not be: «когда буду в настроении»,
 * «приду к выводу», «вернусь к работе», «выйду из себя» speak of no place,
 * and neither do a time («в пятницу», «к 10», «к обеду», «в мае») or a
 * state («в шоке», «на созвоне», «к этому вопросу»): reminders are mostly
 * worded that way. A month and a part of the day only in their own forms:
 * «на Октябрьской», «в Апрелевку» and «в Утрехте» are places, and so is a
 * number with a floor or a room after it («на 3 этаж», «в 105 кабинет»).
 */
const notAPlace = String.raw`(?!\s+(\d(?![\d\s-]*(й|ю|ий|ой|ая|ую)?\s*(этаж|кабинет|корпус|подъезд|квартир|аудитори|офис|школ|терминал))|(себя|себе|it|this|that|them|know|see|meet|think|do|terms|a decision|a conclusion|the point|the meeting|работе|этому|тому|нему|ней|ночь|ночи|ночью|норм[аеу]|нормально|утр[аоу]|утром|ма[йюея]|март[ауе]?|январ[яеь]|феврал[яеь]|апрел[яеь]|июн[яеь]|июл[яеь]|август[ае]?|сентябр[яеь]|октябр[яеь]|ноябр[яеь]|декабр[яеь]|час|часа|часам|часу|часов|один|одному|двум|двух|два|трем|трём|трех|трёх|три|четырем|четырём|четыре|пяти|шести|семи|восьми|девяти|десяти|одиннадцати|двенадцати)(?!\p{L})|форм|настроени|хорош|курсе|связи|сети|силах|состояни|отпуск|больничн|декрет|вывод|решени|согласи|мнени|пониман|итог|цел[иь]|финал|общему|делу|теме|вопрос|шоке|созвон|встреч|совещани|планерк|планёрк|следующ|понедельник|вторник|сред[уеы]|четверг|пятниц|суббот|воскресень|вечер(?!ин)|обед|ужин|завтрак|полдень|полдн|полудн|полноч|выходн))`;

/**
 * Arriving somewhere, after «когда» or «как (только)», with a word between
 * at most: «приду на Тверскую», «буду у мамы», «я вечером приду домой»,
 * «приедем на дачу», but not «приду к выводу» or «приеду в понедельник»
 * (`notAPlace`).
 */
const arriving = String.raw`(я\s+|мы\s+)?(\p{L}+\s+)?(приду|придем|придём|приеду|приедем|доеду|доедем|доберусь|доберемся|доберёмся|дойду|окажусь|окажемся|вернусь|вернемся|вернёмся|буду|будем|подойду|подъеду|зайду|заеду|прилечу|прилетим)\s+((в|во|на|до|к|ко|у|возле|около)(?!\p{L})${notAPlace}|(домой|дома|сюда|туда|там)(?!\p{L}))`;

/** Coming to a place or leaving one: what a reminder at a place waits for. */
const comingAndGoing = [
  String.raw`когда\s+${arriving}`,
  String.raw`как\s+(только\s+)?${arriving}`,
  String.raw`когда\s+(я\s+|мы\s+)?(\p{L}+\s+)?(уйду|уйдем|уйдём|выйду|выйдем|уеду|уедем)\s+(из|с|со|от)(?!\p{L})${notAPlace}`,
  String.raw`(?<!не\s+)(уйду|выйду|уеду|ухожу|выхожу)\s+из\s+дома(?!\p{L})`,
  String.raw`(when|once)\s+i\s+(get|arrive|come)\s+((home|back|there|here)(?!\p{L})(?!\s+to\s+you)|(to|at)(?!\p{L})${notAPlace}(?!\s+(talk|the\s+end)(?!\p{L})))`,
  String.raw`when\s+i(?:'m|’m|\s+am)\s+(home(?!\p{L})|at(?!\p{L})${notAPlace})`,
  String.raw`when\s+i\s+leave(?!\s+(a|an|it|this|that|feedback|comments?|reviews?|notes?)(?!\p{L}))`,
];

/**
 * The person's reminders at places themselves: «покажи мои напоминания у
 * мест», «отмени напоминание у Тверской», «location reminders». The
 * decision model gave no group to «покажи все мои напоминания у мест» (15.10).
 * After «у» a place only: «напоминания у меня на завтра» and «напоминание у
 * задачи» are none, and neither is «напоминание о месте встречи», nor «place
 * reminders» (a verb as often as not).
 */
const placeReminders = [
  String.raw`напомина(ни|лк)\p{L}*\s+((у|возле|около|по|для)\s+мест(у|а|ам|ах)?|о\s+местах)(?!\p{L})`,
  String.raw`напомина(ни|лк)\p{L}*\s+(по|с|на|через)\s+(геолокаци|геопозици|локаци|местоположени|геозон)`,
  String.raw`напомина(ни|лк)\p{L}*\s+(у|возле|около)(?!\p{L})${notAPlace}(?!\s+((меня|тебя|нас|вас|него|нее|неё|них|кого|всех|бро)(?!\p{L})|задач|событи|дел[ауо]?(?!\p{L})|календар|телефон|приложени|будильник|звонк|запис))\s+\p{L}`,
  String.raw`гео[-\s]?напомина(ни|лк)`,
  String.raw`(location|geo)([-\s]?based)?[-\s]?reminders?(?!\p{L})|reminders?\s+(at|for|by|tied\s+to)\s+(places?|locations?)(?!\p{L})`,
];

/**
 * The person's words of where they are or will be, of a reminder bound to
 * a place, or of their reminders at places (`placeReminders`): the decision model gave no group to «напомни купить хлеб,
 * когда приду на Тверскую 7» (15.10). Sharing or following their location
 * too: «я включил трансляцию геопозиции», «можешь следить за моим
 * местоположением». Only words that clearly mean the
 * person's own place: «рядом с текстом», «ближайший понедельник» and «когда
 * буду свободен» are none of it.
 */
const ownPlace = stems(
  ...comingAndGoing,
  ...placeReminders,
  String.raw`где\s+я\s+(сейчас|нахожусь|находил\p{L}*|припарковал\p{L}*|парковал\p{L}*|поставил\p{L}*\s+машин|оставил\p{L}*\s+машин)(?!\p{L})`,
  String.raw`где\s+я\s+был[аи]?(\s*\?|\s+(вчера|сегодня|утром|дн[её]м|вечером|ночью|в\s+\d|час\p{L}*\s+назад)(?!\p{L}))`,
  String.raw`где\s+я\s*\?|где\s+(сейчас\s+)?нахожусь|где\s+моя\s+машин`,
  String.raw`рядом\s+со\s+мной|поблизости|неподал[её]ку|недалеко\s+от\s+меня`,
  String.raw`(трансл\p{L}+|след\p{L}*\s+за|отслежива\p{L}*|смотре\p{L}*\s+за|наблюда\p{L}*\s+за)\s+(мо\p{L}+\s+|сво\p{L}+\s+)?(геопозици|геолокаци|местоположени|мест\p{L}*\s+положени|перемещени)`,
  String.raw`(share|track|follow)\s+my\s+(live\s+)?location|live\s+location`,
  String.raw`where\s+am\s+i(\s+(now|right\s+now))?\s*(\?|$)|where\s+did\s+i\s+park|where\s+i\s+parked|(near|close\s+to)\s+me(?!\p{L})|(?<!the\s+)nearby`
);

const boundToPlace = stems(...comingAndGoing);

const remindWords = stems("напомн", "напомин", "remind");

/** Whether the words speak of the person's own place, now or to come. */
export function speaksOfOwnPlace(words: string) {
  return ownPlace.test(words);
}

/**
 * Whether the words ask to be reminded on coming to a place or leaving it:
 * «напомни купить хлеб, когда приду на Тверскую 7».
 */
export function asksReminderAtPlace(words: string) {
  return remindWords.test(words) && boundToPlace.test(words);
}
