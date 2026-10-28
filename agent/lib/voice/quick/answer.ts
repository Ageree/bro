import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import * as z from "zod";
import { directModelSelection } from "@agent/lib/model/direct";
import { officialRateLines } from "@agent/lib/rates/cbr";
import { findPlaces } from "@agent/lib/routes/openstreetmap";
import { calculateLines } from "@agent/tools/calculate";
import {
  remindInputSchema,
  remindOnce,
  RemindRefusal,
} from "@agent/lib/voice/quick/remind";
import { weatherAt } from "@agent/lib/weather/metno";
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

function instructions(input: {
  now: Date;
  timeZone: string;
  city: string | undefined;
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
    "Ответ — одна-две короткие фразы для произнесения вслух, до 30 слов: без ссылок, списков и разметки, без «по данным». Не упоминай поиск, выдержки и Бро.",
  ].join("\n");
}

/** The person's own words in what the page sends, without the voice's lines. */
function personWords(words: string) {
  return words.replaceAll(voiceLinePattern, " ");
}

/**
 * An errand in the person's words: it goes to Bro without the model's step (0.4–1.3 s), and a mixed «какая
 * завтра погода, если дождь — напомни взять зонт» never loses its reminder to a weather answer. Imperatives
 * only: «во сколько отправление», «сколько стоит купе» are questions.
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
  if (errandWords.test(own)) {
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
  const reminder = { line: "" };
  const aborted = AbortSignal.any([
    AbortSignal.timeout(quickTimeoutMs),
    ...(signal ? [signal] : []),
  ]);
  try {
    const selection = directModelSelection(await getWorkspaceModelId(scope), {
      reasoningOff: true,
      toolChoice: "auto",
    });
    const result = await generateText({
      abortSignal: aborted,
      instructions: instructions(person),
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
              AbortSignal.timeout(searchTimeoutMs)
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
            "Прогноз погоды на сегодня, завтра и послезавтра и погода сейчас. place — город или место в именительном падеже, официальным названием («Санкт-Петербург», не «Питер»); не указывай его, если человек места не назвал.",
          inputSchema: z.object({ place: z.string().trim().min(1).optional() }),
          execute: async ({ place }) => {
            const name = place ?? person.city;
            if (name === undefined)
              return "Где — неизвестно. Вызови to_bro и ничего не пиши.";
            try {
              const found = await findPlaces(
                name,
                undefined,
                { remaining: 1 },
                AbortSignal.any([aborted, AbortSignal.timeout(placeTimeoutMs)]),
                3
              );
              const point = found.toSorted(
                (a, b) => (b.importance ?? 0) - (a.importance ?? 0)
              )[0];
              if (point === undefined)
                return "Место не нашлось. Вызови web_search.";
              const lines = await weatherAt(
                point,
                { now: person.now, timeZone: person.timeZone },
                aborted
              );
              search.found = true;
              return `Прогноз MET Norway для ${point.label}:\n${lines}\n\n${dataNote(english)}`;
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
              const lines = await officialRateLines(codes, person.now, aborted);
              search.found = true;
              return `${lines}\n\n${dataNote(english)} Если нужной валюты у ЦБ нет — вызови web_search.`;
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
            search.found = true;
            return JSON.stringify(calculateLines(lines));
          },
        }),
        remind: tool({
          description:
            "Поставить разовое напоминание на названное человеком время — inMinutes для «через N минут», иначе at.",
          inputSchema: remindInputSchema,
          execute: async (input) => {
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
    outcome("answered", steps);
    return answer;
  } catch (error) {
    outcome(error instanceof Error ? error.name : "failed");
    return undefined;
  }
}
