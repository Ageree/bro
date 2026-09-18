/**
 * Group 4 — buying something and then being asked about it.
 *
 * The contract instructions.md states in one sentence — «после покупки строка
 * уже в `orders`, номер заказа никогда не выдумывай» — is enforced by three
 * modules that have to agree: `orderRecordPolicy` decides whether a finished
 * run is an order at all, `orderPolicy` parses the row, and `broPhrasing`
 * refuses to send a sentence carrying a number the run never produced.
 *
 * The stories walk the whole arc (buy → «где заказ» → cancel) and then each way
 * the arc is supposed to end early: a run parked on 3-D Secure, a card-attach
 * errand that buys nothing, a result with no price in it at all.
 */

import type { Journey, Step } from "./runner.ts";
import {
  merchantFromHost,
  merchantFromTask,
  parseOrderFromResult,
  pendingOrderId,
  resolveMerchant,
} from "../../../convex/lib/orderPolicy.ts";
import { orderRowFromRun } from "../../../convex/lib/orderRecordPolicy.ts";
import {
  isAttachCardErrand,
  purchaseStance,
  taskLooksLikeBuy,
} from "../../../convex/lib/purchasePolicy.ts";
import { doneLineHint, parseCloudOutcome } from "../../../convex/lib/browserOutcomePolicy.ts";
import { doneFacts, sanitizePhrase } from "../../../convex/lib/broPhrasing.ts";
import { doneNowLine, lateResultLine } from "../../../convex/lib/browserProgressPolicy.ts";
import { nextBrowserAction } from "../../../agent/lib/browser-policy.ts";
import { decideCloudInject } from "../../../convex/lib/browserInjectPolicy.ts";
import { turnVoice } from "../../../agent/lib/turn-voice.ts";

const DAY = Date.UTC(2026, 8, 17, 12, 0, 0);

const BOUGHT = [
  "СДЕЛАНО: купил кроссовки Nike Air Max 270, 42 размер",
  "ЗАКАЗ: 5508123",
  "СУММА: 8990",
  "КОГДА: ПВЗ на Ленина 5, послезавтра",
  "НУЖНО: none",
].join("\n");

const PARKED_3DS = ["СДЕЛАНО: нет", "НУЖНО: 3ds", "ДЕТАЛИ: банк просит подтвердить"].join("\n");

/** The one shape a shared step takes in several stories below. */
function stanceStep(text: string, want: "search" | "buy" | "watch_and_buy"): Step {
  return {
    it: `«${text}» читается как «${want}»`,
    got: () => purchaseStance(text),
    want,
  };
}

export const ORDERS: Journey[] = [
  {
    name: "Купил → «где заказ» → отмена: полный круг одной покупки",
    group: "orders",
    steps: [
      stanceStep("купи кроссовки на вб", "buy"),
      {
        it: "прогон закончился чисто — ничего не ждёт человека",
        got: () => parseCloudOutcome(BOUGHT).needs,
        want: "none",
      },
      {
        it: "это покупка, и она попадает в orders",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "купи кроссовки на вб",
            result: BOUGHT,
            paying: true,
            hosts: ["wildberries.ru"],
          })?.merchantOrderId,
        want: "5508123",
      },
      {
        it: "магазин определён по хосту оплаты, а не по словам поручения",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "купи кроссовки",
            result: BOUGHT,
            paying: true,
            hosts: ["ozon.ru"],
          })?.merchant,
        want: "ozon",
      },
      {
        it: "сумма записана числом, а не строкой с рублями",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "купи кроссовки на вб",
            result: BOUGHT,
            paying: true,
          })?.priceRub,
        want: 8990,
      },
      {
        it: "ПВЗ тоже сохранён — «когда ПВЗ» отвечается без браузера",
        got: () =>
          parseOrderFromResult({
            task: "купи кроссовки на вб",
            result: `${BOUGHT}\nПВЗ: Ленина 5`,
          })?.pickup,
        contains: "Ленина 5",
      },
      {
        it: "человеку уходит готово с номером и суммой",
        got: () => doneNowLine("completed", BOUGHT, "run-1"),
        contains: "5508123",
      },
      {
        it: "и без ссылок и служебных ярлыков",
        got: () => doneNowLine("completed", BOUGHT, "run-1"),
        lacks: "НУЖНО",
      },
      {
        it: "«где мой заказ» приходит уже после завершения — новый прогон не нужен",
        got: () =>
          nextBrowserAction({
            runId: "run-1",
            status: "completed",
            storedTask: "купи кроссовки на вб",
            incomingTask: "купи кроссовки на вб",
          }),
        want: "reuse",
      },
      {
        it: "отмена на стороне магазина отражается статусом строки",
        got: () =>
          parseOrderFromResult({
            task: "отмени заказ 5508123 на вб",
            result: "Заказ 5508123 отменён. Товар: кроссовки Nike. Сумма: 8990 руб",
          })?.status,
        want: "cancelled",
      },
      {
        it: "а номер у отменённой строки тот же — есть что сопоставить с orders",
        got: () =>
          parseOrderFromResult({
            task: "отмени заказ 5508123 на вб",
            result: "Заказ 5508123 отменён. Товар: кроссовки Nike. Сумма: 8990 руб",
          })?.merchantOrderId,
        want: "5508123",
      },
    ],
  },

  {
    name: "Заказа нет: прогон завершился, но покупкой это не было",
    group: "orders",
    steps: [
      stanceStep("посмотри сколько стоят кроссовки на вб", "search"),
      {
        it: "поиск без карты и без «купи» строку в orders не пишет",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "посмотри сколько стоят кроссовки на вб",
            result: "Нашёл 3 варианта: 6490, 8990, 11990 руб",
            paying: false,
          }),
        want: null,
      },
      {
        it: "незавершённый прогон — тоже не заказ",
        got: () =>
          orderRowFromRun({ status: "running", task: "купи кроссовки", result: BOUGHT, paying: true }),
        want: null,
      },
      {
        it: "упавший прогон без номера заказа не парсится",
        got: () =>
          parseOrderFromResult({
            task: "купи кроссовки на вб",
            result: "Не удалось оплатить: карта отклонена",
          }),
        want: null,
      },
      {
        it: "результат без цены не становится заказом даже при «купи»",
        got: () =>
          parseOrderFromResult({ task: "купи кроссовки на вб", result: "Оформил заказ" }),
        want: null,
      },
    ],
  },

  {
    name: "Номер заказа не выдумывается — ни парсером, ни фразёром",
    group: "orders",
    steps: [
      {
        it: "номер берётся из текста результата, когда он там есть",
        got: () =>
          parseOrderFromResult({
            task: "купи кроссовки на вб",
            result: "Заказ 5508123 оформлен. Кроссовки Nike. 8990 руб",
          })?.merchantOrderId,
        want: "5508123",
      },
      {
        it: "когда номера нет, строка получает служебный pending-id, а не выдуманный номер",
        got: () =>
          parseOrderFromResult({
            task: "купи кроссовки на вб",
            result: "Купил кроссовки Nike за 8990 руб",
            now: DAY,
          })?.merchantOrderId,
        matches: /^pending:[0-9a-f]{8}$/,
      },
      {
        it: "pending-id стабилен в пределах дня — повторный разбор даёт ту же строку",
        got: () => pendingOrderId("кроссовки Nike", 8990, DAY) === pendingOrderId("кроссовки Nike", 8990, DAY),
        want: true,
      },
      {
        it: "фразёр пропускает отчёт с настоящим номером",
        got: () => {
          const outcome = parseCloudOutcome(BOUGHT);
          return sanitizePhrase("готово, заказ 5508123 на 8990 ₽", "done", doneFacts(outcome));
        },
        contains: "5508123",
      },
      {
        it: "и отбрасывает отчёт с номером, которого прогон не выдавал",
        got: () => {
          const outcome = parseCloudOutcome(BOUGHT);
          return sanitizePhrase("готово, заказ 7770001 на 8990 ₽", "done", doneFacts(outcome));
        },
        want: null,
      },
      {
        it: "и отчёт, в котором номер потерялся, тоже не уходит",
        got: () => {
          const outcome = parseCloudOutcome(BOUGHT);
          return sanitizePhrase("всё, купил", "done", doneFacts(outcome));
        },
        want: null,
      },
    ],
  },

  {
    name: "Длинный номер заказа магазина — номер, а не карта",
    group: "orders",
    steps: [
      {
        it: "десятизначный номер сохраняется как есть",
        got: () =>
          parseOrderFromResult({
            task: "купи кроссовки на вб",
            result: "Заказ 4600012345 оформлен. Кроссовки Nike. 8990 руб",
          })?.merchantOrderId,
        want: "4600012345",
      },
      {
        it: "четырнадцатизначный — тоже номер заказа, а не карта",
        got: () =>
          parseOrderFromResult({
            task: "купи кроссовки на вб",
            result: "Заказ 46000123456789 оформлен. Кроссовки Nike. 8990 руб",
          })?.merchantOrderId,
        want: "46000123456789",
      },
      {
        it: "настоящая карта номером заказа при этом не становится",
        got: () =>
          parseOrderFromResult({
            task: "купи кроссовки на вб",
            result: "Заказ 4111111111111111 оформлен. Кроссовки Nike. 8990 руб",
          })?.merchantOrderId,
        matches: /^pending:/,
      },
    ],
  },

  {
    name: "Прогон встал на 3-D Secure — заказа ещё нет",
    group: "orders",
    steps: [
      {
        it: "результат честно говорит, чего ждёт",
        got: () => parseCloudOutcome(PARKED_3DS).needs,
        want: "3ds",
      },
      {
        it: "строка в orders не пишется — платёж не прошёл",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "купи кроссовки на вб",
            result: PARKED_3DS,
            paying: true,
          }),
        want: null,
      },
      {
        it: "и «готово» тоже не отправляется — это не готово",
        got: () => doneNowLine("completed", PARKED_3DS, "run-2"),
        want: undefined,
      },
      {
        it: "человек получает конкретное «подтверди», а не «что-то пошло не так»",
        got: () => parseCloudOutcome(PARKED_3DS).detail,
        contains: "банк",
      },
      {
        it: "когда он подтвердит, это читается как подтверждение, а не как новое поручение",
        got: () =>
          decideCloudInject("готово, подтвердил", {
            sessionId: "s-1",
            runId: "r-1",
            need: "3ds",
            storedTask: "купи кроссовки на вб",
          }).kind,
        want: "confirm",
      },
    ],
  },

  {
    name: "«Привяжи карту» — поручение есть, заказа нет",
    group: "orders",
    steps: [
      {
        it: "это отдельный вид поручения",
        got: () => isAttachCardErrand("привяжи карту на озоне"),
        want: true,
      },
      {
        it: "и это не покупка",
        got: () => taskLooksLikeBuy("привяжи карту на озоне"),
        want: false,
      },
      {
        it: "рублёвое списание банка в orders не попадает",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "привяжи карту на озоне",
            result: "СДЕЛАНО: карта сохранена\nСУММА: 1\nНУЖНО: none",
            paying: true,
          }),
        want: null,
      },
      {
        it: "«оплати картой из сейфа» привязкой не считается — это покупка",
        got: () => isAttachCardErrand("оплати картой из сейфа"),
        want: false,
      },
      {
        it: "«добавь способ оплаты» — то же поручение другими словами",
        got: () => isAttachCardErrand("добавь способ оплаты"),
        want: true,
      },
      {
        it: "а «привяжи карту и купи кроссовки» остаётся покупкой",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "привяжи карту и купи кроссовки на вб",
            result: BOUGHT,
            paying: true,
          })?.merchantOrderId,
        want: "5508123",
      },
    ],
  },

  {
    name: "Заказ прилетел поздно — человек уже ушёл из чата",
    group: "orders",
    steps: [
      {
        it: "поздний результат оформляется отдельной вводной, а не как свежее «готово»",
        got: () => lateResultLine("completed", BOUGHT, "run-3"),
        contains: "прошлое поручение",
      },
      {
        it: "но факты в нём те же",
        got: () => lateResultLine("completed", BOUGHT, "run-3"),
        contains: "5508123",
      },
      {
        it: "у незавершённого прогона поздней строки нет",
        got: () => lateResultLine("running", BOUGHT, "run-3"),
        want: undefined,
      },
      {
        it: "у прогона, вставшего на человеке, — тоже нет",
        got: () => lateResultLine("completed", PARKED_3DS, "run-3"),
        want: undefined,
      },
      {
        it: "разрешённый исход обязывает ход заговорить — молчать тут нельзя",
        got: () =>
          turnVoice({
            origin: "wakeup",
            shortAck: false,
            waitingForHuman: false,
            jobCheck: false,
            dueNudges: 0,
            browserPollForceSpeak: true,
          }),
        want: "must_speak",
      },
    ],
  },

  {
    name: "«Где заказ», пока Bro занят другим поручением",
    group: "orders",
    steps: [
      {
        it: "идёт такси, а человек просит купить кроссовки — это второе дело",
        got: () =>
          nextBrowserAction({
            runId: "run-taxi",
            status: "running",
            storedTask: "вызови такси домой",
            incomingTask: "купи кроссовки на вб",
          }),
        want: "busy",
      },
      {
        it: "а уточнение про то же такси — просто опрос текущего прогона",
        got: () =>
          nextBrowserAction({
            runId: "run-taxi",
            status: "running",
            storedTask: "вызови такси домой",
            incomingTask: "такси ещё едет?",
          }),
        want: "poll",
      },
      {
        it: "прогон, вставший на адресе, продолжается в той же вкладке",
        got: () =>
          nextBrowserAction({
            runId: "run-taxi",
            status: "completed",
            storedTask: "вызови такси домой",
            incomingTask: "адрес Ленина 5",
            need: "address",
            sessionId: "sess-taxi",
          }),
        want: "continue",
      },
      {
        it: "без сессии продолжать некуда — начинаем заново, а не выдаём старый результат",
        got: () =>
          nextBrowserAction({
            runId: "run-taxi",
            status: "completed",
            storedTask: "вызови такси домой",
            incomingTask: "адрес Ленина 5",
            need: "address",
          }),
        want: "start",
      },
    ],
  },

  {
    name: "Какой это магазин: хост важнее слов, слова важнее догадки",
    group: "orders",
    steps: [
      {
        it: "хост wildberries.ru — это вб",
        got: () => merchantFromHost("https://www.wildberries.ru/catalog/1"),
        want: "wb",
      },
      {
        it: "хост ozon.ru — озон",
        got: () => merchantFromHost("ozon.ru"),
        want: "ozon",
      },
      {
        it: "«купи на вб» без хоста — тоже вб",
        got: () => merchantFromTask("купи кроссовки на вб"),
        want: "wb",
      },
      {
        it: "но слово «вбей» магазином не становится",
        got: () => merchantFromTask("вбей адрес в поиск"),
        want: "other",
      },
      {
        it: "когда хост и слова спорят, выигрывает хост оплаты",
        got: () => resolveMerchant({ task: "купи на вб", hosts: ["ozon.ru"] }),
        want: "ozon",
      },
      {
        it: "неизвестный магазин так и записывается, без угадывания",
        got: () => resolveMerchant({ task: "купи кофе в местной лавке" }),
        want: "other",
      },
    ],
  },

  {
    name: "Сторож «купи, когда подешевеет» доводит покупку до orders",
    group: "orders",
    steps: [
      stanceStep("купи кроссовки, когда будут дешевле 5000", "watch_and_buy"),
      {
        it: "сторож-покупатель считается покупкой для записи заказа",
        got: () => taskLooksLikeBuy("купи кроссовки, когда будут дешевле 5000"),
        want: true,
      },
      {
        it: "сработавший сторож пишет строку в orders",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "купи кроссовки, когда будут дешевле 5000",
            result: BOUGHT,
            paying: true,
            hosts: ["wildberries.ru"],
          })?.status,
        want: "placed",
      },
      {
        it: "а «просто следи» покупкой не считается",
        got: () => taskLooksLikeBuy("следи за ценой на кроссовки"),
        want: false,
      },
      {
        it: "и строки в orders не оставляет",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "следи за ценой на кроссовки",
            result: "Цена упала до 4990 руб",
            paying: false,
          }),
        want: null,
      },
    ],
  },

  {
    name: "Результат без разметки: старый прогон всё равно читается",
    group: "orders",
    steps: [
      {
        it: "у неразмеченного результата это видно по флагу",
        got: () => parseCloudOutcome("Купил кроссовки за 8990 руб, заказ 5508123").labelled,
        want: false,
      },
      {
        it: "и «нужно» угадывается, а не берётся из ярлыка",
        got: () => parseCloudOutcome("Купил кроссовки за 8990 руб").needs,
        want: "none",
      },
      {
        it: "«нужен код из смс» в свободном тексте всё же распознаётся",
        got: () => parseCloudOutcome("Остановился: нужен код из смс").needs,
        want: "sms_code",
      },
      {
        it: "а «код заказа 12345» в успешном отчёте — не просьба о коде",
        got: () => parseCloudOutcome("Готово, код заказа 12345").needs,
        want: "none",
      },
      {
        it: "строку в orders неразмеченный результат всё равно даёт",
        got: () =>
          parseOrderFromResult({
            task: "купи кроссовки на вб",
            result: "Заказ 5508123 оформлен, кроссовки Nike, 8990 руб",
          })?.status,
        want: "placed",
      },
      {
        it: "и человеку она пересказывается фактами, а не сырым текстом",
        got: () => doneLineHint(parseCloudOutcome(BOUGHT)),
        contains: "8990 ₽",
      },
    ],
  },

  {
    name: "Разметка пришла с буллетами и звёздочками — модель так умеет",
    group: "orders",
    steps: [
      {
        it: "«- НУЖНО: none» читается как ярлык",
        got: () => parseCloudOutcome("- СДЕЛАНО: купил\n- НУЖНО: none").labelled,
        want: true,
      },
      {
        it: "«**НУЖНО:** 3ds» — тоже",
        got: () => parseCloudOutcome("**СДЕЛАНО:** нет\n**НУЖНО:** 3ds").needs,
        want: "3ds",
      },
      {
        it: "звёздочки не уезжают в значение",
        got: () => parseCloudOutcome("**СДЕЛАНО:** купил кроссовки\n**НУЖНО:** none").done,
        want: "купил кроссовки",
      },
      {
        it: "«ЗАКАЗ: нет» означает отсутствие номера, а не номер «нет»",
        got: () => parseCloudOutcome("СДЕЛАНО: купил\nЗАКАЗ: нет\nСУММА: 8990\nНУЖНО: none").orderId,
        want: undefined,
      },
      {
        it: "и тогда строка получает pending-id, а не слово «нет»",
        got: () =>
          parseOrderFromResult({
            task: "купи кроссовки на вб",
            result: "СДЕЛАНО: купил кроссовки\nЗАКАЗ: нет\nСУММА: 8990\nНУЖНО: none",
            now: DAY,
          })?.merchantOrderId,
        matches: /^pending:/,
      },
    ],
  },
];
