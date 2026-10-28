import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import * as z from "zod";
import { within } from "@agent/lib/browser-use/deadline";
import { directModelSelection } from "@agent/lib/model/direct";
import { officialRateLines } from "@agent/lib/rates/cbr";
import { findPlaces, type MapPlace } from "@agent/lib/routes/openstreetmap";
import { calculateLines } from "@agent/tools/calculate";
import {
  plainReminder,
  reminderMentioned,
  remindInputSchema,
  remindOnce,
  RemindRefusal,
} from "@agent/lib/voice/quick/remind";
import { placeZone, weatherAt } from "@agent/lib/weather/metno";
import { searchWeb } from "@agent/lib/web-search/search";
import { getWorkspaceModelId } from "@db/services/settings";
import type { AccessScope } from "@shared/identity/access-scope";
import { directModelActive } from "@shared/model/provider";
import { voiceLinePattern } from "@shared/voice/marker";

// /talk's quick answers (VOICE_QUICK_WORKSPACES): a question the web answers — the weather, a rate, the
// news, a fact — goes to one small model call with a web search instead of Bro's turn. Bro's turn reads
// ~80k tokens of prompt and 100 tools over three steps of ~2 s each, and the person waited 7.7–10.2 s for
// such an answer (prod 28.10); this call reads one screen of prompt and answers in 1.5–5 s, 2.5 s typically
// (RunInfra, 9 questions three times, 28.10). It reads and says, nothing else: anything to do, anything of
// the person's own and anything the search does not answer goes on to Bro as before. Since 28.10 it also
// reads the weather (MET Norway) and the bank's rates itself, counts, and sets a one-off reminder: on prod
// a search took 2.3–3.7 s of a 4.5–6.2 s answer.

/** The page waits no longer for a quick answer before it hands the words to Bro. */
const quickTimeoutMs = 7000;
const searchTimeoutMs = 5000;
const placeTimeoutMs = 2500;
const pagesRead = 6;
const answerLimit = 600;
/** Quick answers a workspace gets in a window; past it the words go to Bro. */
const windowLimit = 20;
const windowMs = 5 * 60_000;
/** The wait for the person's home data before the model is asked without it. */
const homeWaitMs = 400;
/** The home data's own limit: past the question's wait it goes on filling the caches for the next one. */
const homeTimeoutMs = 5000;
/** The currencies asked about most, read before the question. */
const homeCurrencies = ["USD", "EUR", "CNY"];
/** A city found on the map, kept: a city does not move. */
const placeKeptMs = 24 * 60 * 60_000;

const placesFound = new Map<
  string,
  { readonly place: MapPlace; readonly until: number }
>();

const asked = new Map<string, number[]>();

/** Room for one more quick answer in the workspace, counted as it is taken. */
function withinLimit(workspaceId: string, now: number) {
  const recent = (asked.get(workspaceId) ?? []).filter(
    (at) => now - at < windowMs
  );
  if (recent.length >= windowLimit) {
    asked.set(workspaceId, recent);
    return false;
  }
  asked.set(workspaceId, [...recent, now]);
  return true;
}

/** The place a city or place name stands for on the map, the best known of the first three. */
async function placeNamed(name: string, signal: AbortSignal) {
  const key = name.toLowerCase();
  const known = placesFound.get(key);
  if (known && known.until > Date.now()) return known.place;
  const found = await findPlaces(name, undefined, { remaining: 1 }, signal, 3);
  const place = found.toSorted(
    (a, b) => (b.importance ?? 0) - (a.importance ?? 0)
  )[0];
  if (place !== undefined)
    placesFound.set(key, { place, until: Date.now() + placeKeptMs });
  return place;
}

/** A place's forecast as the model reads it, with whose it is. */
async function forecastFor(
  place: MapPlace,
  person: { readonly now: Date; readonly timeZone: string },
  signal: AbortSignal
) {
  const lines = await weatherAt(
    place,
    {
      now: person.now,
      timeZone: placeZone(place, person.timeZone, person.now),
    },
    signal
  );
  return `Прогноз MET Norway для ${place.label}:\n${lines}`;
}

/**
 * The person's own city's forecast and the bank's dollar, euro and yuan, read before the question: «какая
 * завтра погода?» and «сколько стоит доллар?» answer from them in one call of the model, ~1 s sooner than
 * with a tool's call and a second one (prod 28.10: 2.1–2.4 s, two calls of 0.7–1.4 s). MET and the bank
 * are kept half an hour and a quarter (`metno.ts`, `cbr.ts`), so after the first question this is no wait.
 */
async function homeData(
  person: {
    readonly now: Date;
    readonly timeZone: string;
    readonly city: string | undefined;
  },
  signal: AbortSignal
) {
  const [weather, rates] = await Promise.all([
    person.city === undefined
      ? undefined
      : placeNamed(person.city, signal)
          .then((place) =>
            place === undefined ? undefined : forecastFor(place, person, signal)
          )
          .catch(() => undefined),
    officialRateLines(homeCurrencies, person.now, signal)
      .then((read) => read.lines)
      .catch(() => undefined),
  ]);
  const parts = [weather, rates].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Reads the home data into the caches when /talk opens, so the first question finds it there. Nothing waits
 * for it, and a failure only leaves the question to read it itself.
 */
export function warmQuickAnswer(person: {
  readonly now: Date;
  readonly timeZone: string;
  readonly city: string | undefined;
}) {
  void homeData(person, AbortSignal.timeout(homeTimeoutMs));
}

/** A text's numbers as written the one way: «07» and «7», «80,50» and «80.5» are each one number. */
function numbersIn(text: string) {
  return (text.match(/\d+(?:[.,]\d+)?/gu) ?? []).map((number) =>
    String(Number(number.replace(",", ".")))
  );
}

/**
 * Whether an answer given straight from the home data rests on it: at least one number, and every number
 * in the home data or the person's words. With no tool's call behind it, an answer from what the model
 * knows — «Канберра», an age, a score — has nothing to check it against and goes to Bro.
 */
function restsOn(answer: string, data: string) {
  const numbers = numbersIn(answer);
  const known = new Set(numbersIn(data));
  return numbers.length > 0 && numbers.every((number) => known.has(number));
}

/**
 * Words of the weather or a rate, in the person's words or the voice's lines before them («А евро?» after
 * the dollar, «а послезавтра?» after «без осадков»). The home data is full of small numbers — degrees,
 * winds, dates — and «сколько будет 2 плюс 2» answered «4» would rest on «+4°»: an answer straight from it
 * stands only in such a conversation.
 */
const homeTopic =
  /погод|дожд|снег|температур|градус|холод|тепл|жар|мороз|ветр|ветер|зонт|осадк|облач|пасмурн|солн|курс|доллар|евро|юан|валют|weather|rain|snow|temperature|cold|warm|hot|wind|umbrella|sunny|dollar|euro|yuan|exchange rate/iu;

function instructions(input: {
  now: Date;
  timeZone: string;
  city: string | undefined;
  home: string | undefined;
  english: boolean;
}) {
  const wall = new Intl.DateTimeFormat("sv-SE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: input.timeZone,
  }).format(input.now);
  const local = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: input.timeZone,
  }).format(input.now);
  return [
    "Ты отвечаешь за голос Бро на быстрые вопросы и одно дело — разовое напоминание.",
    `Сейчас ${local} (${input.timeZone}; по часам — ${wall}).${input.city ? ` Город человека — ${input.city}: бери его, когда вопрос о месте, а город не назван.` : ""}`,
    "Ниже — слова человека из голосового разговора; строки «(ты: «…»)» — твои прежние реплики (голосом и в чате), для понимания: по ним узнавай, о чём речь — город, предмет.",
    "Погода, восход и закат — weather; официальный курс валют ЦБ — rates; арифметика, проценты, дни между датами — calculate; всё прочее, что отвечает интернет (новости, факты, расписания, цены, часы работы, матчи, криптовалюта), — web_search (в запросе — город и дата, когда они важны).",
    "Разовое напоминание на время, которое назвал человек («через 20 минут», «завтра в 9»), о деле из его слов — remind. Повторяющееся («каждый день»), с условием («если…»), без времени или с действием («напомни и позвони») — to_bro.",
    "Если это просьба сделать что-то другое (позвонить, написать, заказать, купить, записать, запомнить, отправить, открыть), если нужны данные самого человека (его почта, календарь, заказы, близкие, память), если это ответ на твой вопрос или слова о деле, которое ты уже делаешь (поиск, заказ, запись), — сразу вызови to_bro, ничего не ища. Так же — если слова без прежнего разговора непонятны («а сколько это стоит?», «а подробнее»).",
    "Ответ — одна-две короткие фразы для произнесения вслух, до 30 слов: без ссылок, списков и разметки, без «по данным», числа — цифрами. Не упоминай поиск, выдержки и Бро.",
    ...(input.home === undefined
      ? []
      : [
          `Уже известно — на вопрос о погоде в городе человека или о курсе этих валют отвечай сразу по этим строкам, ничего не вызывая и ничего не добавляя от себя; о другом месте, другой валюте или другом — инструменты:\n${input.home}`,
        ]),
    // Last, after the data: an answer straight from it reads no tool's note (an English question got a
    // Russian answer 3 times in 3, prototype 28.10).
    languageNote(input.english),
  ].join("\n");
}

/** The person's own words in what the page sends, without the voice's lines. */
function personWords(words: string) {
  return words.replaceAll(voiceLinePattern, " ");
}

/**
 * An errand in the person's words: it goes to Bro without the model's step (0.4–1.3 s). Imperatives only:
 * «во сколько отправление», «сколько стоит купе» are questions. «Напомни» is the quick answer's own when it
 * is a plain one-off (`plainReminder`); anything else with it — «какая завтра погода? если дождь — напомни
 * взять зонт» — goes to Bro whole, or the reminder would be lost to the weather answer.
 */
const errandWords =
  /(?<!\p{L})(?:позвони|набери|закажи|купи|оплати|запиши|отправь|напиши|забронируй|удали|запомни|забудь|переведи|отмени|вызови|включи|выключи|подпиши|скинь|пришли|сохрани|добавь)(?:те)?(?:-ка)?(?!\p{L})/iu;

/**
 * The rule the model reads last, after the pages: given in the instructions alone, it answered «в
 * выдержках нет конкретных новостей…» 2 times in 3 instead of handing over; told «нет ответа или
 * противоречат», it handed over the weather too, where sites differ by a degree (prototype 28.10). The
 * language too: an English question got a Russian answer 2 times in 3.
 */
function answerNote(english: boolean) {
  return `Отвечай по этим выдержкам, их числами: при разных датах — по самой свежей, а если сайты немного расходятся — назови диапазон. Ничего не добавляй от себя. Только если выдержки вовсе не отвечают на вопрос — вызови to_bro и ничего не пиши. ${languageNote(english)}`;
}

function languageNote(english: boolean) {
  return english
    ? "Answer in the language of the question, not in Russian."
    : "Отвечай по-русски.";
}

/** What a data tool's answer is held to, read last as the search's note is. */
function dataNote(english: boolean) {
  return `Отвечай этими числами, ничего не добавляя от себя: только о дне и том, о чём спросили. ${languageNote(english)}`;
}

/** Numbers a count may use without having been seen: units, days, months, percents. */
const freeNumbers = new Set([
  "7",
  "12",
  "24",
  "60",
  "100",
  "365",
  "366",
  "1000",
]);

/**
 * Whether every number of a calculator line was seen — in the person's words, today's date or a tool's
 * answer — or is a small or unit one: «100 * 92» with a dollar rate the model remembers is no answer.
 */
function numbersSeen(line: string, seen: string) {
  const known = new Set(numbersIn(seen));
  return numbersIn(line).every(
    (number) =>
      known.has(number) ||
      freeNumbers.has(number) ||
      (Number.isInteger(Number(number)) && Number(number) <= 31)
  );
}

/**
 * The line the voice retells for the person's words, or undefined when they go to Bro: an errand, the
 * person's own data, a search that does not answer, a failure, the time out, the limit. Never throws.
 */
export async function quickVoiceAnswer(
  scope: AccessScope,
  words: string,
  person: {
    now: Date;
    timeZone: string;
    city: string | undefined;
    /** The page's Bro chat, where a reminder is made. */
    chat: string | undefined;
  },
  signal?: AbortSignal
) {
  const startedAt = performance.now();
  let searchMs: number | undefined;
  // How long each call of the model took, the tools' time aside.
  const stepMs: number[] = [];
  let stepFrom = startedAt;
  const outcome = (kind: string, steps?: number) => {
    console.info("[voice] quick", {
      kind,
      ms: Math.round(performance.now() - startedAt),
      searchMs,
      stepMs,
      steps,
      workspaceId: scope.workspaceId,
    });
  };
  if (!directModelActive()) return undefined;
  const own = personWords(words);
  // A reminder with a condition, a repeat or a question beside it goes to
  // Bro whole: answered here, its reminder would be lost to the answer.
  if (
    errandWords.test(own) ||
    (reminderMentioned(own) && !plainReminder(own))
  ) {
    outcome("errand");
    return undefined;
  }
  if (!withinLimit(scope.workspaceId, Date.now())) {
    outcome("limit");
    return undefined;
  }
  const english = !/\p{Script=Cyrillic}/u.test(own);
  // Only data a tool brought back stands behind an answer: a failed search is
  // no ground for the model's text after it. A reminder that was set is the
  // answer itself.
  const search = { found: false };
  const reminder = { calls: 0, line: "" };
  // What a count may rest on: the person's words, today's date and what the
  // tools brought back — not a rate the model remembers.
  const seen = { text: `${own} ${person.now.toISOString()}` };
  const aborted = AbortSignal.any([
    AbortSignal.timeout(quickTimeoutMs),
    ...(signal ? [signal] : []),
  ]);
  try {
    const [modelId, homeRead] = await Promise.all([
      getWorkspaceModelId(scope),
      within(homeData(person, AbortSignal.timeout(homeTimeoutMs)), homeWaitMs),
    ]);
    const home = homeRead.timedOut ? undefined : homeRead.value;
    const selection = directModelSelection(modelId, {
      reasoningOff: true,
      toolChoice: "auto",
    });
    const result = await generateText({
      abortSignal: aborted,
      instructions: instructions({ ...person, home, english }),
      // An answer over ~65 tokens took 0.9–1.8 s against 0.5–0.9 s for a
      // short one (probe 28.10); the voice retells a sentence or two.
      maxOutputTokens: 160,
      model: selection.model,
      prompt: words,
      providerOptions: selection.modelOptions.providerOptions,
      // A reminder's line is said as it is: no step after it.
      stopWhen: [stepCountIs(3), hasToolCall("remind")],
      onLanguageModelCallStart: () => {
        stepFrom = performance.now();
      },
      onLanguageModelCallEnd: () => {
        stepMs.push(Math.round(performance.now() - stepFrom));
      },
      tools: {
        web_search: tool({
          description:
            "Ищет в интернете. Запрос — по-русски, с городом и датой, когда они важны.",
          inputSchema: z.object({ query: z.string().min(1) }),
          execute: async ({ query }) => {
            const from = performance.now();
            const pages = await searchWeb(
              { query },
              AbortSignal.any([aborted, AbortSignal.timeout(searchTimeoutMs)])
            ).catch(() => []);
            searchMs = Math.round(performance.now() - from);
            if (pages.length === 0)
              return "Поиск ничего не дал. Вызови to_bro и ничего не пиши.";
            search.found = true;
            const excerpts = pages
              .slice(0, pagesRead)
              .map(
                (page) =>
                  `${page.title}${page.date ? ` (${page.date})` : ""}: ${page.snippet}`
              )
              .join("\n\n");
            return `${excerpts}\n\n${answerNote(english)}`;
          },
        }),
        weather: tool({
          description:
            "Погода сейчас и прогноз на неделю вперёд по дням. place — город или место в именительном падеже, официальным названием («Санкт-Петербург», не «Питер»); не указывай его, если человек места не назвал.",
          inputSchema: z.object({ place: z.string().trim().min(1).optional() }),
          execute: async ({ place }) => {
            const name = place ?? person.city;
            if (name === undefined)
              return "Где — неизвестно. Вызови to_bro и ничего не пиши.";
            try {
              const point = await placeNamed(
                name,
                AbortSignal.any([aborted, AbortSignal.timeout(placeTimeoutMs)])
              );
              if (point === undefined)
                return "Место не нашлось. Вызови web_search.";
              const forecast = await forecastFor(point, person, aborted);
              search.found = true;
              seen.text += forecast;
              return `${forecast}\n\n${dataNote(english)}`;
            } catch {
              return "Прогноз не ответил. Вызови web_search.";
            }
          },
        }),
        rates: tool({
          description:
            "Официальный курс ЦБ РФ на сегодня (и на завтра, когда уже установлен). codes — коды валют ISO: USD, EUR, CNY.",
          inputSchema: z.object({
            codes: z.array(z.string().trim().min(3).max(3)).min(1).max(5),
          }),
          execute: async ({ codes }) => {
            try {
              const read = await officialRateLines(codes, person.now, aborted);
              seen.text += read.lines;
              // A code the bank does not quote is no ground for a figure.
              if (read.quoted > 0) search.found = true;
              return `${read.lines}\n\n${dataNote(english)} Если нужной валюты у ЦБ нет — вызови web_search.`;
            } catch {
              return "ЦБ не ответил. Вызови web_search.";
            }
          },
        }),
        calculate: tool({
          description:
            "Точный счёт: по выражению в строке, «x = …» — переменная для строк ниже; date(год, месяц, день) — номер дня, разность двух — дни между датами.",
          inputSchema: z.object({
            lines: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
          }),
          execute: ({ lines }) => {
            const counted = calculateLines(lines);
            if (
              counted.every((line) => !("error" in line)) &&
              lines.every((line) => numbersSeen(line, seen.text))
            )
              search.found = true;
            return JSON.stringify(counted);
          },
        }),
        remind: tool({
          description:
            "Поставить разовое напоминание на названное человеком время — inMinutes для «через N минут», иначе at.",
          inputSchema: remindInputSchema,
          execute: async (input) => {
            reminder.calls += 1;
            if (reminder.calls > 1)
              return "Одно напоминание за раз: второе не поставлено.";
            try {
              reminder.line = await remindOnce(scope, input, {
                chat: person.chat,
                now: person.now,
                signal: aborted,
                timeZone: person.timeZone,
                words,
              });
              return reminder.line;
            } catch (error) {
              if (!(error instanceof RemindRefusal)) throw error;
              console.info("[voice] quick reminder refused", {
                reason: error.message,
              });
              return "Не поставлено.";
            }
          },
        }),
        // No execute: a call ends the loop, and the words go to Bro.
        to_bro: tool({
          description:
            "Передать слова основному Бро: просьба что-то сделать, данные самого человека или поиск не ответил.",
          inputSchema: z.object({}),
        }),
      },
    });
    const calls = result.steps.flatMap((step) => step.toolCalls);
    const steps = result.steps.length;
    if (calls.some((call) => call.toolName === "remind")) {
      outcome(reminder.line === "" ? "reminder_refused" : "reminded", steps);
      return reminder.line === "" ? undefined : reminder.line;
    }
    if (calls.some((call) => call.toolName === "to_bro")) {
      outcome(search.found ? "unanswered" : "to_bro", steps);
      return undefined;
    }
    // One line: the page hands it to Bro later inside a voice line.
    const answer = result.text.replaceAll(/\s+/gu, " ").trim();
    // Straight from the home data, no tool called: only its own numbers stand.
    const fromHome =
      calls.length === 0 &&
      home !== undefined &&
      homeTopic.test(words) &&
      restsOn(answer, `${home}\n${own}`);
    if (fromHome) search.found = true;
    // An answer with no pages behind it is a guess at what changes: the
    // rate, the weather, the score.
    // «В выдержках нет конкретных новостей…» told the person nothing: the
    // model said it in 26 news answers of 38 against the rule (probe 28.10).
    if (
      !search.found ||
      answer === "" ||
      answer.length > answerLimit ||
      /выдержк/iu.test(answer)
    ) {
      outcome(search.found ? "no_answer" : "unsearched", steps);
      return undefined;
    }
    outcome(fromHome ? "home" : "answered", steps);
    return answer;
  } catch (error) {
    outcome(error instanceof Error ? error.name : "failed");
    return undefined;
  }
}
