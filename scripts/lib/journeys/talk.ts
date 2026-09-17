/**
 * Group 8 — the conversation itself.
 *
 * `turnVoice` is one pure function with a strict priority order, and nearly
 * every complaint a person has about a chat agent is a wrong row in it: an «ок»
 * answered with a paragraph, an «ок» that silently stalls the job it was
 * answering, a resolved errand that never reached the human, a background check
 * that wrote «просто чтобы отметиться».
 *
 * The centre of the group is the pair the owner called out by name: «ок» with
 * nothing waiting and «ок» while a job waits on THIS person are the same word
 * and must get DIFFERENT verdicts — `ack_only` versus `ack_confirms`. Both are
 * walked end to end below, because the difference only shows up downstream, in
 * what the model is then told to do.
 */

import type { Journey } from "./runner.ts";
import { repoText } from "./runner.ts";
import { turnVoice, voiceInstruction, type VoiceInput } from "../../../agent/lib/turn-voice.ts";
import { isShortAck, isShortAckTurn, shortAckAttribute } from "../../../agent/lib/short-ack.ts";
import {
  fallbackForFailed,
  isSilentReply,
  TURN_FAILED_REPLY,
  TURN_STALLED_REPLY,
  turnOrigin,
} from "../../../agent/lib/silent-turn.ts";
import {
  defaultCheckInMinutes,
  nudgePrompt,
  shouldNudge,
  shouldSpeakNotSilent,
} from "../../../convex/lib/jobNudgePolicy.ts";
import { fastAckAttribute, peelFastAck, sanitizeFastAck, shouldFastAck } from "../../../agent/lib/fast-ack.ts";
import { decideCloudInject, steerCandidate } from "../../../convex/lib/browserInjectPolicy.ts";
import { ackSessionLive, isAckLike } from "../../../agent/lib/browser-task-policy.ts";
import { doneFacts, sanitizePhrase } from "../../../convex/lib/broPhrasing.ts";
import { parseCloudOutcome } from "../../../convex/lib/browserOutcomePolicy.ts";
import { nextProgressNote } from "../../../convex/lib/browserProgressPolicy.ts";
import { instinctWakePrompt } from "../../../convex/lib/instinctPolicy.ts";

const INSTRUCTIONS = repoText("agent/instructions.md");

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

const BASE: VoiceInput = {
  origin: "human",
  shortAck: false,
  waitingForHuman: false,
  jobCheck: false,
  dueNudges: 0,
  browserPollForceSpeak: false,
};

const LIVE_TAXI = {
  sessionId: "sess-taxi",
  runId: "run-taxi",
  status: "running",
  storedTask: "вызови такси домой",
  browserListed: true,
  now: NOW,
};

export const TALK: Journey[] = [
  {
    name: "«Спасибо» просто так — короткий ответ и на этом всё",
    group: "talk",
    steps: [
      {
        it: "«спасибо» — это короткое подтверждение",
        got: () => isShortAck("спасибо"),
        want: true,
      },
      {
        it: "канал ставит на ход отметку, а не догадывается по истории",
        got: () => shortAckAttribute("спасибо"),
        want: { shortAck: "1" },
      },
      {
        it: "отметка читается только на ходе человека",
        got: () => isShortAckTurn({ origin: "human", shortAck: "1" }),
        want: true,
      },
      {
        it: "и не читается на фоновом ходе — иначе будильник станет «ок»",
        got: () => isShortAckTurn({ origin: "wakeup", shortAck: "1" }),
        want: false,
      },
      {
        it: "ничего не ждёт человека — вердикт «только подтверждение»",
        got: () => turnVoice({ ...BASE, shortAck: true }),
        want: "ack_only",
      },
      {
        it: "модели говорят ответить одной строкой",
        got: () => voiceInstruction("ack_only"),
        contains: "one short line",
      },
      {
        it: "и не звать тяжёлые тулы",
        got: () => voiceInstruction("ack_only"),
        contains: "Do not call browser_task",
      },
      {
        it: "быстрая строка «взялся» на «спасибо» тоже не нужна",
        got: () => shouldFastAck("спасибо"),
        want: false,
      },
      {
        it: "и не штампуется на ход",
        got: () => fastAckAttribute(null),
        want: {},
      },
    ],
  },

  {
    name: "То же «ок», но его ждёт открытый джоб — это ответ, а не вежливость",
    group: "talk",
    steps: [
      {
        it: "слово ровно то же самое",
        got: () => isShortAck("ок"),
        want: true,
      },
      {
        it: "но джоб ждёт именно этого человека",
        got: () => turnVoice({ ...BASE, shortAck: true, waitingForHuman: true }),
        want: "ack_confirms",
      },
      {
        it: "и это ДРУГОЙ вердикт, чем у праздного «ок»",
        got: () =>
          turnVoice({ ...BASE, shortAck: true }) === turnVoice({ ...BASE, shortAck: true, waitingForHuman: true }),
        want: false,
      },
      {
        it: "модели прямо говорят: это подтверждение, а не новая просьба",
        got: () => voiceInstruction("ack_confirms"),
        contains: "that is the confirmation",
      },
      {
        it: "и велят делать следующий шаг, а не переспрашивать",
        got: () => voiceInstruction("ack_confirms"),
        contains: "do not ask them to confirm again",
      },
      {
        it: "молчать в этом ходе нельзя — иначе джоб встанет",
        got: () => voiceInstruction("ack_confirms"),
        lacks: "[SILENT]",
      },
      {
        it: "у праздного «ок» молчание, наоборот, разрешено",
        got: () => voiceInstruction("ack_only"),
        contains: "[SILENT]",
      },
      {
        it: "джоб, ждущий человека, будит через двадцать минут",
        got: () => defaultCheckInMinutes("human"),
        want: 20,
      },
      {
        it: "и на таком нудже Bro всегда говорит вслух",
        got: () => shouldSpeakNotSilent("human"),
        want: true,
      },
    ],
  },

  {
    name: "«Спасибо» сразу после завершённого поручения, пока стартует новое",
    group: "talk",
    steps: [
      {
        it: "старый прогон уже завершён",
        got: () => ackSessionLive({ browserStatus: "completed", browserStartingAt: NOW - 5_000 }, NOW),
        want: false,
      },
      {
        it: "и поэтому «спасибо» читается как обычный ack, а не как деталь к поручению",
        got: () => isAckLike("спасибо", { sessionLive: false }),
        want: true,
      },
      {
        it: "пока прогон идёт, короткая строка ack-ом не считается",
        got: () => isAckLike("на воскресенье", { sessionLive: true }),
        want: false,
      },
      {
        it: "активный прогон делает сессию живой",
        got: () => ackSessionLive({ browserStatus: "running" }, NOW),
        want: true,
      },
      {
        it: "заявленный, но ещё не подтверждённый старт — тоже",
        got: () => ackSessionLive({ browserStartingAt: NOW - 5_000 }, NOW),
        want: true,
      },
      {
        it: "протухшая заявка на старт — уже нет",
        got: () => ackSessionLive({ browserStartingAt: NOW - 10 * 60_000 }, NOW),
        want: false,
      },
    ],
  },

  {
    name: "Болтовня во время поручения остаётся в чате и до вендора не доезжает",
    group: "talk",
    steps: [
      {
        it: "«ну что там» — вопрос Bro, а не деталь поручения",
        got: () => decideCloudInject("ну что там", LIVE_TAXI).kind,
        want: null,
      },
      {
        it: "«привет» — тем более",
        got: () => steerCandidate("привет"),
        want: false,
      },
      {
        it: "«кстати вчера был в кино» — рассказ, а не инструкция",
        got: () => decideCloudInject("кстати вчера был в кино", LIVE_TAXI).kind,
        want: null,
      },
      {
        it: "вопрос со знаком вопроса тоже не уезжает",
        got: () => decideCloudInject("долго ещё?", LIVE_TAXI).kind,
        want: null,
      },
      {
        it: "эмодзи — не инструкция",
        got: () => decideCloudInject("👍", LIVE_TAXI).kind,
        want: null,
      },
      {
        it: "а «ну что там 4 человека» — уже параметр поручения, приставку срезают",
        got: () => steerCandidate("что там 4 человека"),
        want: true,
      },
      {
        it: "и «на воскресенье» — тоже, без всякого глагола",
        got: () => decideCloudInject("на воскресенье", LIVE_TAXI).kind,
        want: "steer",
      },
      {
        it: "инструкция продукта велит болтать в ответ, а не предлагать помощь",
        got: () => INSTRUCTIONS,
        contains: "Просто болтает — болтай",
      },
    ],
  },

  {
    name: "Плохую новость говорят первой строкой и не размазывают",
    group: "talk",
    steps: [
      {
        it: "инструкция требует именно этого",
        got: () => INSTRUCTIONS,
        contains: "Плохую новость — первой строкой",
      },
      {
        it: "и запрещает делать вид, что получилось",
        got: () => INSTRUCTIONS,
        contains: "не делай вид, что получилось",
      },
      {
        it: "у упавшего хода есть готовая честная фраза",
        got: () => TURN_FAILED_REPLY,
        satisfies: (t) => typeof t === "string" && t.length > 0,
        wanted: "непустой текст на случай падения хода",
      },
      {
        it: "и у зависшего — своя",
        got: () => TURN_STALLED_REPLY,
        satisfies: (t) => typeof t === "string" && t.length > 0 && t !== TURN_FAILED_REPLY,
        wanted: "отдельный текст на случай, когда ход завис",
      },
      {
        it: "на ходе человека провал озвучивается, а не проглатывается",
        got: () => fallbackForFailed({ origin: "human" }),
        want: TURN_FAILED_REPLY,
      },
      {
        it: "а если «взялся» уже ушло — говорят именно про зависшее дело",
        got: () => fallbackForFailed({ origin: "human" }, { status: true }),
        want: TURN_STALLED_REPLY,
      },
      {
        it: "у разрешившегося браузерного будильника своя готовая строка",
        got: () =>
          fallbackForFailed({
            origin: "wakeup",
            wakeupKind: "browser_poll",
            wakeupPhase: "done",
            wakeupFallback: "Готово: такси заказано.",
          }),
        want: "Готово: такси заказано.",
      },
      {
        it: "а обычный фоновый ход, упавший молча, человека не будит",
        got: () => fallbackForFailed({ origin: "wakeup" }),
        want: null,
      },
      {
        it: "робо-извинения при этом запрещены прямым списком",
        got: () => INSTRUCTIONS,
        contains: "Прошу прощения за доставленные неудобства",
      },
    ],
  },

  {
    name: "Молчание — нормальный ход, а не сбой",
    group: "talk",
    steps: [
      {
        it: "фоновая проверка джоба никому ничего не должна",
        got: () => turnVoice({ ...BASE, origin: "wakeup", jobCheck: true }),
        want: "may_silent",
      },
      {
        it: "любой другой будильник без срочного дела — тоже",
        got: () => turnVoice({ ...BASE, origin: "wakeup" }),
        want: "may_silent",
      },
      {
        it: "и инструкция такого хода прямо предлагает ответить [SILENT]",
        got: () => voiceInstruction("may_silent"),
        contains: "[SILENT]",
      },
      {
        it: "[SILENT] действительно читается как молчание",
        got: () => isSilentReply("[SILENT]"),
        want: true,
      },
      {
        it: "а обычная строка — нет",
        got: () => isSilentReply("готово, заказал"),
        want: false,
      },
      {
        it: "происхождение хода читается из атрибутов, а не угадывается",
        got: () => [turnOrigin({ origin: "wakeup" }), turnOrigin({ origin: "human" })],
        want: ["wakeup", "human"],
      },
      {
        it: "фоновый скан тоже называет молчание ожидаемым исходом",
        got: () =>
          instinctWakePrompt([
            { kind: "calendar_soon", summary: "Созвон", at: NOW + 40 * 60_000, sourceId: "c1" },
          ]),
        contains: "Молчание здесь нормальный",
      },
      {
        it: "и инструкция продукта говорит то же самое",
        got: () => INSTRUCTIONS,
        contains: "пустой ход это нормально",
      },
    ],
  },

  {
    name: "Исход уже решён — тут молчать нельзя ни при каких вердиктах",
    group: "talk",
    steps: [
      {
        it: "разрешившееся браузерное поручение обязывает заговорить",
        got: () => turnVoice({ ...BASE, origin: "wakeup", browserPollForceSpeak: true }),
        want: "must_speak",
      },
      {
        it: "созревший нудж — тоже",
        got: () => turnVoice({ ...BASE, origin: "wakeup", jobCheck: true, dueNudges: 1 }),
        want: "must_speak",
      },
      {
        it: "и это перебивает даже короткое «ок»",
        got: () => turnVoice({ ...BASE, shortAck: true, browserPollForceSpeak: true }),
        want: "must_speak",
      },
      {
        it: "инструкция такого хода прямо называет [SILENT] багом",
        got: () => voiceInstruction("must_speak"),
        contains: "[SILENT] would leave him on read",
      },
      {
        it: "нудж встраивается в ту же строку, а не отдельным противоречащим абзацем",
        got: () =>
          voiceInstruction("must_speak", { nudges: ["Нужен твой ответ: подтвердить запись."] }),
        contains: "Нужен твой ответ",
      },
      {
        it: "и ни один вердикт не просит модель игнорировать другую инструкцию",
        got: () =>
          (["must_speak", "ack_only", "ack_confirms", "may_silent"] as const)
            .map((v) => voiceInstruction(v) ?? "")
            .join("\n"),
        lacks: "ignore any later",
      },
      {
        it: "обычный ход голосовых ограничений не несёт вовсе",
        got: () => voiceInstruction("free"),
        want: null,
      },
    ],
  },

  {
    name: "Нудж по зависшему джобу: сначала тишина, потом строка",
    group: "talk",
    steps: [
      {
        it: "через пять минут после «жду» будить рано",
        got: () => shouldNudge({ waitingFor: "human", waitingSince: NOW - 5 * 60_000, now: NOW }),
        want: false,
      },
      {
        it: "через двадцать пять — пора",
        got: () => shouldNudge({ waitingFor: "human", waitingSince: NOW - 25 * 60_000, now: NOW }),
        want: true,
      },
      {
        it: "но если только что уже нудили — не дважды подряд",
        got: () =>
          shouldNudge({
            waitingFor: "human",
            waitingSince: NOW - 25 * 60_000,
            lastNudgeAt: NOW - 60_000,
            now: NOW,
          }),
        want: false,
      },
      {
        it: "джоб, ждущий браузер, проверяется чаще — раз в восемь минут",
        got: () => defaultCheckInMinutes("browser"),
        want: 8,
      },
      {
        it: "текст нуджа называет дело, а не «проверяю статус»",
        got: () => nudgePrompt({ waitingFor: "human", goal: "подтвердить запись к врачу" }),
        contains: "подтвердить запись к врачу",
      },
      {
        it: "у браузерного ожидания своя формулировка",
        got: () => nudgePrompt({ waitingFor: "browser", goal: "оплата на озоне" }),
        contains: "браузер",
      },
      {
        it: "джоб без момента начала ожидания не нудит вовсе",
        got: () => shouldNudge({ waitingFor: "human", now: NOW }),
        want: false,
      },
    ],
  },

  {
    name: "Строка «взялся»: живая, короткая и каждый раз новая",
    group: "talk",
    steps: [
      {
        it: "на поручение она нужна",
        got: () => shouldFastAck("купи кроссовки на вб"),
        want: true,
      },
      {
        it: "на служебное событие — нет",
        got: () => shouldFastAck("[event:mail] что-то пришло"),
        want: false,
      },
      {
        it: "на код в чате — тоже нет: решает настоящий ход, а не крошечная модель",
        got: () => shouldFastAck("482911"),
        want: false,
      },
      {
        it: "на «подожди» — нет по той же причине",
        got: () => shouldFastAck("подожди"),
        want: false,
      },
      {
        it: "нормальная строка проходит фильтр",
        got: () => sanitizeFastAck("окей, гляну заказ"),
        want: "окей, гляну заказ",
      },
      {
        it: "целое предложение — нет",
        got: () => sanitizeFastAck("Конечно! Сейчас найду кроссовки на WB и пришлю варианты"),
        want: null,
      },
      {
        it: "строка со ссылкой — нет",
        got: () => sanitizeFastAck("смотри https://wildberries.ru"),
        want: null,
      },
      {
        it: "«Бро, …» в начале — нет",
        got: () => sanitizeFastAck("Бро, сейчас гляну"),
        want: null,
      },
      {
        it: "«Статус: …» — нет",
        got: () => sanitizeFastAck("Статус: ищу"),
        want: null,
      },
      {
        it: "если модель повторила ту же мысль, повтор снимается",
        got: () => peelFastAck("гляну заказ", "гляну заказ"),
        want: null,
      },
      {
        it: "инструкция задаёт форму строки: 2–6 слов, с маленькой буквы",
        got: () => INSTRUCTIONS,
        contains: "2–6 слов",
      },
    ],
  },

  {
    name: "Робо-вступление проходит фильтр «взялся»",
    group: "talk",
    knownGap:
      "sanitizeFastAck пропускает «Конечно! Сейчас я всё сделаю» — по форме это 5 слов и 28 символов, а список запрещённых открывашек («Конечно! Сейчас я…») живёт только в instructions.md и на крошечную модель fast-ack не распространяется. Итог: первая строка, которую человек видит чаще всего, иногда звучит ровно так, как продукт запретил. Минимальный фикс: добавить в sanitizeFastAck отказ по тем же открывашкам, что уже перечислены в §Voice («конечно», «задача принята», «выполняю», «готов помочь»).",
    steps: [
      {
        it: "инструкция называет эту фразу роботом",
        got: () => INSTRUCTIONS,
        contains: "«Конечно! Сейчас я…»",
      },
      {
        it: "и фильтр «взялся» должен её отбрасывать",
        got: () => sanitizeFastAck("Конечно! Сейчас я всё сделаю"),
        want: null,
      },
      {
        it: "«Задача принята» — та же категория",
        got: () => sanitizeFastAck("Задача принята"),
        want: null,
      },
      {
        it: "а живая строка остаётся живой",
        got: () => sanitizeFastAck("понял, делаю"),
        want: "понял, делаю",
      },
    ],
  },

  {
    name: "Долгое поручение: свежая строка вместо «напиши позже»",
    group: "talk",
    steps: [
      {
        it: "на восьмидесятой секунде уместно сказать, что страница открылась",
        got: () =>
          nextProgressNote({
            status: "running",
            startedAt: 0,
            now: 80_000,
            pageUrl: "https://www.wildberries.ru/catalog/1",
            task: "купи кроссовки",
            loginWait: false,
            sent: [],
            seed: "run-1",
          })?.key,
        want: "opened",
      },
      {
        it: "ту же строку второй раз не шлют",
        got: () =>
          nextProgressNote({
            status: "running",
            startedAt: 0,
            now: 90_000,
            pageUrl: "https://www.wildberries.ru/catalog/1",
            task: "купи кроссовки",
            loginWait: false,
            sent: ["opened"],
            seed: "run-1",
          })?.key,
        want: "slow",
      },
      {
        it: "у завершённого прогона прогресс-строк нет — момент принадлежит отчёту",
        got: () =>
          nextProgressNote({
            status: "completed",
            startedAt: 0,
            now: 300_000,
            task: "купи кроссовки",
            loginWait: false,
            sent: [],
            seed: "run-1",
          }),
        want: undefined,
      },
      {
        it: "ожидание входа прогресс-строк тоже не получает — там ждут человека, а не сайт",
        got: () =>
          nextProgressNote({
            status: "running",
            startedAt: 0,
            now: 300_000,
            task: "[bro-login] вход",
            loginWait: true,
            sent: [],
            seed: "run-1",
          }),
        want: undefined,
      },
      {
        it: "формулировка стабильна: тот же прогон даёт ту же строку",
        got: () => {
          const one = nextProgressNote({
            status: "running",
            startedAt: 0,
            now: 80_000,
            pageUrl: "https://www.wildberries.ru/catalog/1",
            task: "купи кроссовки",
            loginWait: false,
            sent: [],
            seed: "run-1",
          });
          const two = nextProgressNote({
            status: "running",
            startedAt: 0,
            now: 80_000,
            pageUrl: "https://www.wildberries.ru/catalog/1",
            task: "купи кроссовки",
            loginWait: false,
            sent: [],
            seed: "run-1",
          });
          return one?.text === two?.text;
        },
        want: true,
      },
    ],
  },

  {
    name: "Bro не пересказывает цифры, которых не было",
    group: "talk",
    steps: [
      {
        it: "у отчёта есть факты, из которых он собран",
        got: () => doneFacts(parseCloudOutcome("СДЕЛАНО: купил\nЗАКАЗ: 5508123\nСУММА: 8990\nНУЖНО: none")).orderId,
        want: "5508123",
      },
      {
        it: "перефразированный отчёт с теми же фактами проходит",
        got: () =>
          sanitizePhrase(
            "всё, забрал: заказ 5508123, 8990 ₽",
            "done",
            doneFacts(parseCloudOutcome("СДЕЛАНО: купил\nЗАКАЗ: 5508123\nСУММА: 8990\nНУЖНО: none")),
          ),
        contains: "5508123",
      },
      {
        it: "с эмодзи — не проходит, это не голос продукта",
        got: () =>
          sanitizePhrase(
            "готово 🎉 заказ 5508123, 8990 ₽",
            "done",
            doneFacts(parseCloudOutcome("СДЕЛАНО: купил\nЗАКАЗ: 5508123\nСУММА: 8990\nНУЖНО: none")),
          ),
        want: null,
      },
      {
        it: "со ссылкой — тоже не проходит",
        got: () =>
          sanitizePhrase(
            "готово, https://wildberries.ru/lk заказ 5508123, 8990 ₽",
            "done",
            doneFacts(parseCloudOutcome("СДЕЛАНО: купил\nЗАКАЗ: 5508123\nСУММА: 8990\nНУЖНО: none")),
          ),
        want: null,
      },
      {
        it: "и с «Бро, …» в начале",
        got: () =>
          sanitizePhrase(
            "Бро, заказ 5508123 на 8990 ₽",
            "done",
            doneFacts(parseCloudOutcome("СДЕЛАНО: купил\nЗАКАЗ: 5508123\nСУММА: 8990\nНУЖНО: none")),
          ),
        want: null,
      },
      {
        it: "длинная строка про долгий прогон обязана оставить человеку выход",
        got: () => sanitizePhrase("всё ещё вожусь, скажешь отмени — брошу", "long", { kind: "long" } as never),
        contains: "отмени",
      },
    ],
  },
];
