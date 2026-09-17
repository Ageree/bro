/**
 * Group 5 — paying with the card in the vault, and the four ways a payment is
 * supposed to stop.
 *
 * The vault itself (`convex/lib/vaultPayload.ts`) imports `convex/values` and is
 * out of bounds for an offline journey, so the stories run one layer up, where
 * the money actually moves: which hosts a card is bound to, what the Cloud run
 * is told about a ceiling, and what Bro says when a run parks on 3-D Secure, a
 * missing card or a missing login.
 *
 * The bar every story here holds to: nothing that names a card, a CVV or a site
 * password may travel back into the chat, and nothing may be typed into a site
 * that was not bound to that site up front.
 */

import type { Journey } from "./runner.ts";
import {
  cardBindings,
  expandLoginHosts,
  expandPayHosts,
  loginBindings,
  loginScaffold,
  normalizePayHost,
  normalizePayHosts,
  PAY_ALIASES,
  PAY_HOST_LIMIT,
  payScaffold,
  registrableDomain,
} from "../../../agent/lib/browser-pay.ts";
import {
  budgetRub,
  isAttachCardErrand,
  overspend,
  overspendLine,
  purchaseStance,
  watcherBuys,
  watcherShouldPay,
} from "../../../convex/lib/purchasePolicy.ts";
import { humanLineForNeed, parseCloudOutcome } from "../../../convex/lib/browserOutcomePolicy.ts";
import { orderRowFromRun } from "../../../convex/lib/orderRecordPolicy.ts";
import {
  carriesSecretValue,
  cloudInjectAttribute,
  decideCloudInject,
  injectQueueText,
  INJECT_NO_PASSWORD_HINT,
} from "../../../convex/lib/browserInjectPolicy.ts";
import { looksLikeCardNumber, scrubSecrets } from "../../../convex/lib/secretScrub.ts";
import {
  alreadyLoggedChatText,
  cookieDomainsCoverPage,
  loginChatText,
  loginWaitTask,
  nextLoginAction,
  profileSyncStatus,
} from "../../../convex/lib/browserProfilePolicy.ts";
import { doneNowLine } from "../../../convex/lib/browserProgressPolicy.ts";

// The full vault payload, not a convenient subset: `cardBindings` takes the
// stored shape, and a fixture that omits half of it tests a type that does not
// exist in production.
const CARD = {
  kind: "payment-card",
  version: 1,
  cardholderName: "NIKITA EROKHIN",
  number: "4111111111111111",
  expirationMonth: 7,
  expirationYear: 2029,
  securityCode: "123",
  billingPostalCode: undefined,
} as const;

/** A Browser Use profile id is a UUID — anything else is «no profile». */
const PROFILE_ID = "3f1c9a20-5b7e-4d61-9f02-1a2b3c4d5e6f";

const LOGIN = {
  kind: "login" as const,
  version: 1 as const,
  origin: "https://www.wildberries.ru",
  identifier: { type: "email" as const, value: "person@example.com" },
  authentication: { type: "password" as const, password: "Hunter2024" },
};

export const PAY: Journey[] = [
  {
    name: "Карта в сейфе есть — платим сразу, без витрины «какой взять?»",
    group: "pay",
    steps: [
      {
        it: "«купи кроссовки на вб» — это покупка, а не поиск",
        got: () => purchaseStance("купи кроссовки на вб"),
        want: "buy",
      },
      {
        it: "хост магазина нормализуется до домена",
        got: () => normalizePayHost("https://www.wildberries.ru/catalog/1?sort=popular"),
        want: "wildberries.ru",
      },
      {
        it: "карта привязывается и к магазину, и к его процессингу",
        got: () => expandPayHosts(["wildberries.ru"]),
        contains: "yookassa.ru",
      },
      {
        it: "но не ко всему интернету — список ограничен",
        got: () => expandPayHosts(["wildberries.ru"]).length <= PAY_HOST_LIMIT,
        want: true,
      },
      {
        it: "секреты карты уезжают алиасами, значений модель не видит",
        got: () => cardBindings(CARD, ["wildberries.ru"]).map((b) => b.alias),
        contains: PAY_ALIASES.number,
      },
      {
        it: "каждый секрет ограничен теми же хостами",
        got: () => cardBindings(CARD, ["wildberries.ru"]).every((b) => b.allowedDomains.includes("wildberries.ru")),
        want: true,
      },
      {
        it: "инструкция прогону говорит просить секрет по имени, а не печатать номер",
        got: () => payScaffold({ hosts: ["wildberries.ru"] }),
        contains: "ты значений не видишь",
      },
      {
        it: "и сам номер карты в тексте задания не встречается",
        got: () => payScaffold({ hosts: ["wildberries.ru"] }),
        lacks: CARD.number,
      },
      {
        it: "покупка дошла до конца — строка в orders появилась",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "купи кроссовки на вб",
            result: "СДЕЛАНО: купил кроссовки\nЗАКАЗ: 5508123\nСУММА: 8990\nНУЖНО: none",
            paying: true,
            hosts: ["wildberries.ru"],
          })?.status,
        want: "placed",
      },
    ],
  },

  {
    name: "Карты в сейфе нет — прогон останавливается и говорит, чего не хватает",
    group: "pay",
    steps: [
      {
        it: "прогон закончился с «нужна оплата»",
        got: () => parseCloudOutcome("СДЕЛАНО: нет\nНУЖНО: payment\nДЕТАЛИ: карта не привязана").needs,
        want: "payment",
      },
      {
        it: "человеку это переводится в одну человеческую строку",
        got: () => humanLineForNeed("payment"),
        contains: "картой",
      },
      {
        it: "с деталями от прогона, если они есть",
        got: () => humanLineForNeed("payment", { detail: "карта не привязана" }),
        contains: "карта не привязана",
      },
      {
        it: "строки в orders не появляется — покупки не было",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "купи кроссовки на вб",
            result: "СДЕЛАНО: нет\nНУЖНО: payment",
            paying: false,
          }),
        want: null,
      },
      {
        it: "и «готово» тоже не отправляется — прогон встал, а не закончил",
        got: () => doneNowLine("completed", "СДЕЛАНО: нет\nНУЖНО: payment", "run-pay"),
        want: undefined,
      },
    ],
  },

  {
    name: "Сумма выше названного потолка — карта не идёт",
    group: "pay",
    steps: [
      {
        it: "«до 3000» читается как потолок",
        got: () => budgetRub("купи кроссовки до 3000"),
        want: 3000,
      },
      {
        it: "«не дороже 4к» — тоже",
        got: () => budgetRub("купи кроссовки не дороже 4к"),
        want: 4000,
      },
      {
        it: "без названного потолка его нет, а не «ноль»",
        got: () => budgetRub("купи кроссовки на вб"),
        want: undefined,
      },
      {
        it: "потолок уезжает в задание отдельной стоп-строкой",
        got: () => payScaffold({ hosts: ["wildberries.ru"], maxRub: 3000 }),
        contains: "выше 3000",
      },
      {
        it: "сторож с потолком не платит по цене выше него",
        got: () => watcherShouldPay({ payload: "купи когда подешевеет до 3000", currentPriceRub: 3500 }),
        want: false,
      },
      {
        it: "по цене ниже — платит",
        got: () => watcherShouldPay({ payload: "купи когда подешевеет до 3000", currentPriceRub: 2900 }),
        want: true,
      },
      {
        it: "сторож-наблюдатель не платит вообще, какой бы ни была цена",
        got: () => watcherShouldPay({ payload: "следи за ценой на кроссовки", currentPriceRub: 10 }),
        want: false,
      },
      {
        it: "и это видно по самому сторожу",
        got: () => [watcherBuys("купи когда подешевеет до 3000"), watcherBuys("следи за ценой")],
        want: [true, false],
      },
    ],
  },

  {
    name: "3-D Secure: подтверждает человек, ссылкой, а не кодом из почты",
    group: "pay",
    steps: [
      {
        it: "прогон паркуется на 3ds",
        got: () => parseCloudOutcome("НУЖНО: 3ds\nДЕТАЛИ: банк ждёт подтверждения").needs,
        want: "3ds",
      },
      {
        it: "с живой ссылкой человеку уходит именно она",
        got: () => humanLineForNeed("3ds", { liveUrl: "https://live.browser-use.com/x" }),
        contains: "https://live.browser-use.com/x",
      },
      {
        it: "и просят написать «готово», а не прислать код",
        got: () => humanLineForNeed("3ds", { liveUrl: "https://live.browser-use.com/x" }),
        lacks: "код",
      },
      {
        it: "«готово» после этого читается как подтверждение",
        got: () =>
          decideCloudInject("готово", {
            sessionId: "s-1",
            runId: "r-1",
            need: "3ds",
            storedTask: "купи кроссовки на вб",
          }).kind,
        want: "confirm",
      },
      {
        it: "в сессию уезжает «проверь, продвинулся ли экран», а не повторный ввод",
        got: () => injectQueueText({ kind: "confirm", humanText: "готово" }),
        contains: "Ничего не вводи повторно",
      },
      {
        it: "заказ при этом ещё не записан",
        got: () =>
          orderRowFromRun({
            status: "completed",
            task: "купи кроссовки на вб",
            result: "НУЖНО: 3ds",
            paying: true,
          }),
        want: null,
      },
    ],
  },

  {
    name: "Без ссылки Bro не зовёт открыть то, чего не присылал",
    group: "pay",
    steps: [
      {
        it: "со ссылкой формулировка корректна",
        got: () => humanLineForNeed("3ds", { liveUrl: "https://live/x" }),
        contains: "открой ссылку",
      },
      {
        it: "без ссылки про ссылку речи быть не должно",
        got: () => humanLineForNeed("3ds"),
        lacks: "ссылк",
      },
      {
        it: "то же для капчи",
        got: () => humanLineForNeed("captcha"),
        lacks: "по ссылке",
      },
      {
        it: "для пароля это уже сделано правильно — без ссылки текст другой",
        got: () => humanLineForNeed("password", { site: "wildberries.ru" }),
        contains: "Добавь его в сейф",
      },
    ],
  },

  {
    name: "«Привяжи карту» без покупки — карта сохраняется, заказ не оформляется",
    group: "pay",
    steps: [
      {
        it: "поручение распознаётся как привязка",
        got: () => isAttachCardErrand("привяжи карту на озоне"),
        want: true,
      },
      {
        it: "задание прогону начинается со «Способов оплаты», а не с корзины",
        got: () => payScaffold({ hosts: ["ozon.ru"], attachCard: true }),
        contains: "Добавить карту",
      },
      {
        it: "карта всё равно привязана только к озону и процессингу",
        got: () => expandPayHosts(["ozon.ru"]).includes("ozon.ru"),
        want: true,
      },
      {
        it: "заказа из такого прогона не выходит",
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
        it: "«карту привяжи» с другим порядком слов — то же поручение",
        got: () => isAttachCardErrand("карту привяжи, пожалуйста"),
        want: true,
      },
    ],
  },

  {
    name: "Человек пытается продиктовать номер карты в чат",
    group: "pay",
    steps: [
      {
        it: "номер карты распознаётся по Луну, а не по длине",
        got: () => looksLikeCardNumber("4111 1111 1111 1111"),
        want: true,
      },
      {
        it: "трек-номер такой же длины картой не считается",
        got: () => looksLikeCardNumber("46000123456789"),
        want: false,
      },
      {
        it: "в свободном тексте номер вычищается",
        got: () => scrubSecrets("плати вот этой: 4111 1111 1111 1111"),
        lacks: "4111",
      },
      {
        it: "а номер заказа рядом остаётся нетронутым",
        got: () => scrubSecrets("проверь заказ 46000123456789"),
        contains: "46000123456789",
      },
      {
        it: "такая строка не становится инъекцией в живую сессию",
        got: () =>
          decideCloudInject("карта 4111 1111 1111 1111", {
            sessionId: "s-1",
            status: "running",
            storedTask: "купи кроссовки на вб",
            browserListed: true,
          }).kind,
        want: null,
      },
      {
        it: "и не штампуется на ход, чтобы не всплыть следующим",
        got: () => cloudInjectAttribute("карта 4111 1111 1111 1111"),
        want: {},
      },
      {
        it: "если бы дошло до очереди, последний рубеж всё равно вырезал бы номер",
        got: () => injectQueueText({ kind: "steer", humanText: "плати картой 4111 1111 1111 1111" }),
        contains: "[card]",
      },
      {
        it: "CVV в чате вычищается вместе с меткой",
        got: () => scrubSecrets("cvv 123"),
        want: "cvv [cvv]",
      },
    ],
  },

  {
    name: "Человек присылает пароль от магазина — это отказ, а не удобство",
    group: "pay",
    steps: [
      {
        it: "строка с паролем помечена как несущая секрет",
        got: () => carriesSecretValue("пароль от вб: зайка2024"),
        want: true,
      },
      {
        it: "голый токен вида Hunter2024 — тоже",
        got: () => carriesSecretValue("Hunter2024"),
        want: true,
      },
      {
        it: "а «забыл пароль, восстанови» — обычное поручение, значения там нет",
        got: () => carriesSecretValue("забыл пароль, восстанови"),
        want: false,
      },
      {
        it: "пароль в живую сессию не уезжает ни одним из видов инъекции",
        got: () =>
          decideCloudInject("логин vasya пароль Hunter2024", {
            sessionId: "s-1",
            status: "running",
            storedTask: "купи кроссовки на вб",
          }).kind,
        want: null,
      },
      {
        it: "у продукта есть готовая фраза, что пароль сайта в чат не просят",
        got: () => INJECT_NO_PASSWORD_HINT,
        contains: "Не проси пароль сайта в чат",
      },
      {
        it: "секрет входа из сейфа уезжает алиасом, а не текстом",
        got: () => loginBindings(LOGIN, ["wildberries.ru"]).map((b) => b.alias).length,
        want: 2,
      },
      {
        it: "и задание прогону тоже говорит про имена секретов",
        got: () => loginScaffold(),
        contains: "Значения вводит сервер",
      },
      {
        it: "сам пароль в задании не появляется",
        got: () => loginScaffold(),
        lacks: "Hunter2024",
      },
    ],
  },

  {
    name: "Вход уже сохранён — ссылку слать незачем",
    group: "pay",
    steps: [
      {
        it: "куки покрывают страницу магазина",
        got: () => cookieDomainsCoverPage(["wildberries.ru"], "https://www.wildberries.ru/catalog/1"),
        want: true,
      },
      {
        it: "профиль считается синхронизированным",
        got: () => profileSyncStatus({ profileId: PROFILE_ID, cookieDomains: ["wildberries.ru"] }),
        want: "synced",
      },
      {
        it: "профиль без куки — пустой, а не готовый",
        got: () => profileSyncStatus({ profileId: PROFILE_ID, cookieDomains: [] }),
        want: "empty",
      },
      {
        it: "человеку говорят, что ссылка не нужна",
        got: () => alreadyLoggedChatText("wildberries.ru"),
        contains: "ссылка не нужна",
      },
      {
        it: "чужие куки чужой сайт не покрывают",
        got: () => cookieDomainsCoverPage(["ozon.ru"], "https://www.wildberries.ru/catalog/1"),
        want: false,
      },
      {
        it: "и тогда следующий шаг — открыть вход заново, а не переиспользовать закрытый прогон",
        got: () =>
          nextLoginAction({
            runId: "run-login",
            status: "completed",
            storedTask: loginWaitTask("https://www.wildberries.ru/security/login"),
            startedAt: 1_000,
            page: "https://www.wildberries.ru/security/login",
            now: 2_000,
          }),
        want: "start",
      },
      {
        it: "а свежий прогон по тому же входу переиспользуется, а не удваивается",
        got: () =>
          nextLoginAction({
            runId: "run-login",
            status: "running",
            storedTask: loginWaitTask("https://www.wildberries.ru/security/login"),
            startedAt: 1_000,
            page: "https://www.wildberries.ru/security/login",
            now: 2_000,
          }),
        want: "reuse",
      },
      {
        it: "ссылка на живую вкладку уходит человеку как ссылка, а не как «войди сам»",
        got: () => loginChatText("https://live.browser-use.com/x", "wildberries.ru"),
        contains: "https://live.browser-use.com/x",
      },
    ],
  },

  {
    name: "Карта привязана к магазину — на чужом домене платить нечем",
    group: "pay",
    steps: [
      {
        it: "домен магазина сводится к регистрируемому",
        got: () => registrableDomain("secure.wildberries.ru"),
        want: "wildberries.ru",
      },
      {
        it: "поддомены магазина покрыты",
        got: () => expandPayHosts(["www.wildberries.ru"]).includes("wildberries.ru"),
        want: true,
      },
      {
        it: "чужой магазин — нет",
        got: () => expandPayHosts(["wildberries.ru"]).includes("ozon.ru"),
        want: false,
      },
      {
        it: "мусор в списке хостов отбрасывается, а не превращается в хост",
        got: () => normalizePayHosts(["не-хост", "ozon.ru"]),
        want: ["ozon.ru"],
      },
      {
        it: "вход привязывается отдельно от карты",
        got: () => expandLoginHosts(["wildberries.ru"]).includes("wildberries.ru"),
        want: true,
      },
      {
        it: "задание прогону прямо велит остановиться на чужом домене оплаты",
        got: () => payScaffold({ hosts: ["wildberries.ru"] }),
        contains: "чужом домене",
      },
      {
        it: "привязка без хостов вообще запрещена — иначе карта уйдёт куда угодно",
        got: () => {
          try {
            cardBindings(CARD, []);
            return "не бросило";
          } catch (err) {
            return err instanceof Error ? "бросило" : "странно";
          }
        },
        want: "бросило",
      },
    ],
  },

  {
    name: "Держателя карты нет в сейфе — в задание не уезжает слово «undefined»",
    group: "pay",
    steps: [
      {
        it: "без держателя предложения про держателя нет",
        got: () => payScaffold({ hosts: ["wildberries.ru"] }),
        lacks: "undefined",
      },
      {
        it: "с держателем оно появляется",
        got: () => payScaffold({ hosts: ["wildberries.ru"], holder: "IVAN IVANOV" }),
        contains: "IVAN IVANOV",
      },
      {
        it: "без ярлыка карты задание всё равно осмысленно",
        got: () => payScaffold({ hosts: ["wildberries.ru"] }),
        contains: "Карта подключена секретами",
      },
      {
        it: "с ярлыком он подставляется как есть",
        got: () => payScaffold({ hosts: ["wildberries.ru"], account: "Visa · •••• 1111" }),
        contains: "•••• 1111",
      },
      {
        it: "и это по-прежнему не номер карты",
        got: () => payScaffold({ hosts: ["wildberries.ru"], account: "Visa · •••• 1111" }),
        lacks: CARD.number,
      },
    ],
  },

  {
    name: "Списали больше, чем разрешили — человек узнаёт это от Bro, а не от банка",
    group: "pay",
    steps: [
      {
        it: "потолок назван человеком",
        got: () => budgetRub("купи кроссовки до 5000"),
        want: 5000,
      },
      {
        it: "прогон отчитался о сумме",
        got: () => parseCloudOutcome("СДЕЛАНО: купил\nСУММА: 6200\nНУЖНО: none").amountRub,
        want: 6200,
      },
      {
        it: "перерасход посчитан, а не проигнорирован",
        got: () => overspend({ paidRub: 6200, maxRub: 5000 }),
        want: { paidRub: 6200, maxRub: 5000, overRub: 1200 },
      },
      {
        it: "ровно по потолку перерасходом не считается",
        got: () => overspend({ paidRub: 5000, maxRub: 5000 }),
        want: null,
      },
      {
        it: "без названного потолка сравнивать не с чем",
        got: () => overspend({ paidRub: 6200 }),
        want: null,
      },
      {
        it: "и человеку это говорится первой строкой, а не прячется в «готово»",
        got: () => overspendLine({ paidRub: 6200, maxRub: 5000 }),
        contains: "первой строкой",
      },
    ],
  },
];
