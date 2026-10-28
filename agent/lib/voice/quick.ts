import { generateText, stepCountIs, tool } from "ai";
import * as z from "zod";
import { directModelSelection } from "@agent/lib/model/direct";
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
// the person's own and anything the search does not answer goes on to Bro as before.

/** The page waits no longer for a quick answer before it hands the words to Bro. */
const quickTimeoutMs = 7000;
const searchTimeoutMs = 5000;
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
  const local = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: input.timeZone,
  }).format(input.now);
  return [
    "Ты отвечаешь за голос Бро на вопросы, на которые отвечает поиск в интернете: погода, курсы, новости, факты, расписания, цены, часы работы, результаты матчей.",
    `Сейчас ${local} (${input.timeZone}).${input.city ? ` Город человека — ${input.city}: бери его, когда вопрос о месте, а город не назван.` : ""}`,
    "Ниже — слова человека из голосового разговора; строки «(ты: «…»)» — реплики голоса между ними, для понимания.",
    "Если это просьба что-то сделать (напомнить, позвонить, написать, заказать, купить, записать, запомнить, отправить, открыть), если нужны данные самого человека (его почта, календарь, заказы, близкие, память) или ответ на вопрос голоса — сразу вызови to_bro, ничего не ища. Так же — если последние слова продолжают разговор, которого здесь нет, и без него непонятны («а сколько это стоит?», «а подробнее»).",
    "Иначе вызови web_search (в запросе — город и дата, когда они важны) и ответь одной-двумя короткими фразами для произнесения вслух: без ссылок, списков и разметки, без «по данным». Не упоминай поиск, выдержки и Бро.",
  ].join("\n");
}

/** The person's own words in what the page sends, without the voice's lines. */
function personWords(words: string) {
  return words.replaceAll(voiceLinePattern, " ");
}

/**
 * The rule the model reads last, after the pages: given in the instructions alone, it answered «в
 * выдержках нет конкретных новостей…» 2 times in 3 instead of handing over; told «нет ответа или
 * противоречат», it handed over the weather too, where sites differ by a degree (prototype 28.10). The
 * language too: an English question got a Russian answer 2 times in 3.
 */
function answerNote(english: boolean) {
  return `Отвечай по этим выдержкам, их числами: при разных датах — по самой свежей, а если сайты немного расходятся — назови диапазон. Ничего не добавляй от себя. Только если выдержки вовсе не отвечают на вопрос — вызови to_bro и ничего не пиши. ${english ? "Answer in the language of the question, not in Russian." : "Отвечай по-русски."}`;
}

/**
 * The line the voice retells for the person's words, or undefined when they go to Bro: an errand, the
 * person's own data, a search that does not answer, a failure, the time out, the limit. Never throws.
 */
export async function quickVoiceAnswer(
  scope: AccessScope,
  words: string,
  person: { now: Date; timeZone: string; city: string | undefined }
) {
  const startedAt = performance.now();
  let searchMs: number | undefined;
  const outcome = (kind: string, steps?: number) => {
    console.info("[voice] quick", {
      kind,
      ms: Math.round(performance.now() - startedAt),
      searchMs,
      steps,
      workspaceId: scope.workspaceId,
    });
  };
  if (!directModelActive()) return undefined;
  if (!withinLimit(scope.workspaceId, Date.now())) {
    outcome("limit");
    return undefined;
  }
  const english = !/\p{Script=Cyrillic}/u.test(personWords(words));
  try {
    const selection = directModelSelection(await getWorkspaceModelId(scope), {
      reasoningOff: true,
      toolChoice: "auto",
    });
    const result = await generateText({
      abortSignal: AbortSignal.timeout(quickTimeoutMs),
      instructions: instructions(person),
      maxOutputTokens: 300,
      model: selection.model,
      prompt: words,
      providerOptions: selection.modelOptions.providerOptions,
      stopWhen: stepCountIs(3),
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
            );
            searchMs = Math.round(performance.now() - from);
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
        // No execute: a call ends the loop, and the words go to Bro.
        to_bro: tool({
          description:
            "Передать слова основному Бро: просьба что-то сделать, данные самого человека или поиск не ответил.",
          inputSchema: z.object({}),
        }),
      },
    });
    const calls = result.steps.flatMap((step) => step.toolCalls);
    const searched = calls.some((call) => call.toolName === "web_search");
    const steps = result.steps.length;
    if (calls.some((call) => call.toolName === "to_bro")) {
      outcome(searched ? "unanswered" : "to_bro", steps);
      return undefined;
    }
    const answer = result.text.trim();
    // An answer with no search behind it is a guess at what changes: the
    // rate, the weather, the score.
    if (!searched || answer === "" || answer.length > answerLimit) {
      outcome(searched ? "no_answer" : "unsearched", steps);
      return undefined;
    }
    outcome("answered", steps);
    return answer;
  } catch (error) {
    outcome(error instanceof Error ? error.name : "failed");
    return undefined;
  }
}
