import {
  generateText,
  hasToolCall,
  type ModelMessage,
  stepCountIs,
  tool,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
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
/** The wait for each part of the person's home data before the question goes on without it. */
const homeWaitMs = 400;
/** The home data's own limit: past the question's wait it goes on filling the caches for the next one. */
const homeTimeoutMs = 5000;
/** The currencies asked about most, read before the question. */
const homeCurrencies = ["USD", "EUR", "CNY"];

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

/**
 * The place a city or place name stands for on the map, the best known of the first three. `findPlaces`
 * keeps its answers a day, so a city is looked up once.
 */
async function placeNamed(name: string, signal: AbortSignal) {
  const found = await findPlaces(name, undefined, { remaining: 1 }, signal, 3);
  return found.toSorted((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
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

interface HomePerson {
  readonly now: Date;
  readonly timeZone: string;
  readonly city: string | undefined;
}

/** The forecast of the person's own city, or nothing without a city or a place for it. */
async function homeForecast(person: HomePerson, signal: AbortSignal) {
  if (person.city === undefined) return undefined;
  const place = await placeNamed(person.city, signal);
  return place === undefined ? undefined : forecastFor(place, person, signal);
}

/**
 * Reads the home city's forecast and the bank's dollar, euro and yuan into the caches when /talk opens
 * (MET is kept half an hour, the bank a quarter: `metno.ts`, `cbr.ts`), so the first question finds them.
 * Nothing waits for it, and a failure only leaves the question to read them itself.
 */
export function warmQuickAnswer(person: HomePerson) {
  const signal = AbortSignal.timeout(homeTimeoutMs);
  homeForecast(person, signal).catch(() => undefined);
  officialRateLines(homeCurrencies, person.now, signal).catch(() => undefined);
}

/** Weather words in the person's own words, at a word's start: «дождь», not «пожар» or «train». */
const weatherAsked =
  /(?<!\p{L})(?:погод|дожд|снег|температур|градус|холодн|тепл|жарк|мороз|ветр|ветер|зонт|осадк|солнечн|weather|rain|snow|temperature|cold|warm|hot|wind|umbrella|sunny)/iu;
/** One of the currencies read ahead, named in the person's own words. */
const ratesAsked = /(?<!\p{L})(?:доллар|евро|юан|dollar|euro|yuan)/iu;
/** A day past the week the forecast tells. */
const farDay = /(?<!\p{L})(?:следующ|через недел|через месяц|next|in a week)/iu;

/**
 * Whether the person's words name a place other than their own city: a capitalised word past a sentence's
 * first («Какая погода в Казани?», «in London»). A place written small is missed; the forecast handed over
 * then says whose it is, and the model asks the weather tool for the other one.
 */
function namesOtherPlace(own: string, city: string | undefined) {
  const stem = city?.toLowerCase().slice(0, 4);
  return own.split(/(?<=[.!?])\s+/u).some((sentence) =>
    sentence
      .trim()
      .split(/\s+/u)
      .slice(1)
      .some(
        (word) =>
          /^\p{Lu}\p{Ll}/u.test(word) &&
          (stem === undefined || !word.toLowerCase().startsWith(stem))
      )
  );
}

/** What the weather tool gives the model: the forecast and the rule its answer keeps. */
function weatherResult(forecast: string, english: boolean) {
  return `${forecast}\n\n${dataNote(english)}`;
}

/** What the rates tool gives the model. */
function ratesResult(lines: string, english: boolean) {
  return `${lines}\n\n${dataNote(english)} Если нужной валюты у ЦБ нет — вызови web_search.`;
}

/**
 * The weather tool's and the rates tool's answers, as if the model had already called them, when the
 * person's own words ask the weather of their own city within the week or a rate of the dollar, euro or
 * yuan: «какая завтра погода?» and «сколько стоит доллар?» then take one call of the model, not a tool's
 * call and a second one (prod 28.10: 2.1–2.4 s, two calls of 0.7–1.4 s). Code decides, from the person's
 * own words: with the data in the instructions instead, the model answered other questions from it, and
 * no check of its numbers held — a week of degrees and dates holds nearly every small one (review 28.10).
 * A part not read within its wait is left out, and the model calls the tool itself as before.
 */
async function homeCalls(own: string, person: HomePerson, english: boolean) {
  const signal = AbortSignal.timeout(homeTimeoutMs);
  const weather =
    weatherAsked.test(own) &&
    !farDay.test(own) &&
    !namesOtherPlace(own, person.city);
  const [forecast, rates] = await Promise.all([
    weather
      ? within(
          homeForecast(person, signal).catch(() => undefined),
          homeWaitMs
        )
      : undefined,
    ratesAsked.test(own)
      ? within(
          officialRateLines(homeCurrencies, person.now, signal).catch(
            () => undefined
          ),
          homeWaitMs
        )
      : undefined,
  ]);
  const calls: ToolCallPart[] = [];
  const results: ToolResultPart[] = [];
  let data = "";
  if (forecast?.timedOut === false && forecast.value !== undefined) {
    calls.push({
      input: {},
      toolCallId: "call_home_weather",
      toolName: "weather",
      type: "tool-call",
    });
    results.push({
      output: { type: "text", value: weatherResult(forecast.value, english) },
      toolCallId: "call_home_weather",
      toolName: "weather",
      type: "tool-result",
    });
    data += forecast.value;
  }
  if (
    rates?.timedOut === false &&
    rates.value !== undefined &&
    rates.value.quoted > 0
  ) {
    calls.push({
      input: { codes: homeCurrencies },
      toolCallId: "call_home_rates",
      toolName: "rates",
      type: "tool-call",
    });
    results.push({
      output: { type: "text", value: ratesResult(rates.value.lines, english) },
      toolCallId: "call_home_rates",
      toolName: "rates",
      type: "tool-result",
    });
    data += rates.value.lines;
  }
  const messages: ModelMessage[] =
    calls.length === 0
      ? []
      : [
          { content: calls, role: "assistant" },
          { content: results, role: "tool" },
        ];
  return { data, handed: calls.map((call) => call.toolName), messages };
}

/** A text's numbers as written the one way: «07» and «7», «80,50» and «80.5» are each one number. */
function numbersIn(text: string) {
  return (text.match(/\d+(?:[.,]\d+)?/gu) ?? []).map((number) =>
    String(Number(number.replace(",", ".")))
  );
}

function instructions(input: {
  now: Date;
  timeZone: string;
  city: string | undefined;
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
  // The tools the model ran, and the home data handed to it as tools' answers.
  const used: string[] = [];
  const handed: string[] = [];
  const outcome = (kind: string, steps?: number) => {
    console.info("[voice] quick", {
      handed,
      kind,
      ms: Math.round(performance.now() - startedAt),
      searchMs,
      stepMs,
      steps,
      tools: used,
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
    const [modelId, home] = await Promise.all([
      getWorkspaceModelId(scope),
      homeCalls(own, person, english),
    ]);
    handed.push(...home.handed);
    // The home data handed over stands behind the answer as a tool's would.
    if (home.data !== "") {
      search.found = true;
      seen.text += home.data;
    }
    const selection = directModelSelection(modelId, {
      reasoningOff: true,
      toolChoice: "auto",
    });
    const result = await generateText({
      abortSignal: aborted,
      instructions: instructions({ ...person, english }),
      // An answer over ~65 tokens took 0.9–1.8 s against 0.5–0.9 s for a
      // short one (probe 28.10); the voice retells a sentence or two.
      maxOutputTokens: 160,
      messages: [{ content: words, role: "user" }, ...home.messages],
      model: selection.model,
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
            used.push("web_search");
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
            used.push("weather");
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
              return weatherResult(forecast, english);
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
            used.push("rates");
            try {
              const read = await officialRateLines(codes, person.now, aborted);
              seen.text += read.lines;
              // A code the bank does not quote is no ground for a figure.
              if (read.quoted > 0) search.found = true;
              return ratesResult(read.lines, english);
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
            used.push("calculate");
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
            used.push("remind");
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
      used.push("to_bro");
      outcome(search.found ? "unanswered" : "to_bro", steps);
      return undefined;
    }
    // One line: the page hands it to Bro later inside a voice line.
    const answer = result.text.replaceAll(/\s+/gu, " ").trim();
    // Answered from the home data handed over, with no call of its own.
    const fromHome = home.data !== "" && calls.length === 0;
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
