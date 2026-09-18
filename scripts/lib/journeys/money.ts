/**
 * Group 10 — money and access: the quota, the paywall, the cabinet, the test
 * tenancy, and the handle that ties a phone to exactly one Bro.
 *
 * None of this is glamorous and all of it is load-bearing: a wrong verdict here
 * either bills a person who should not be billed, or silences one who should be
 * talking. The single most dangerous branch is the accounting FAILURE path — a
 * Convex rate-limit call that throws must not turn into a silent Bro, and must
 * not turn into a paywall message resent every minute either.
 */

import type { Journey } from "./runner.ts";
import {
  ALLOWANCE_MAX,
  BROWSER_JOBS_UNLIMITED,
  browserAllowance,
  browserAllowedOnLimitError,
  browserGateFromResult,
  carryCountersOnTzChange,
  clampAllowance,
  consumeCount,
  dayKey,
  effectiveUsedCount,
  extendPaidUntil,
  inboundGateFromResult,
  inboundOnAccountingError,
  isPaid,
  legacyUsedForPeriod,
  monthKey,
  msgAllowance,
  payReturnUrl,
  paywallDecision,
  rateLimitPeriodKey,
  usedCount,
  RATE_COUNTER_CAP,
} from "../../../convex/lib/billingPolicy.ts";
import {
  accessCreatesPerHour,
  DEFAULT_ACCESS_CREATES_PER_HOUR,
  DEFAULT_IDENTITY_CAP,
  identityCap,
  identityCapReached,
  isIosUserAgent,
  isValidHandle,
  makeHandle,
  webhookUrlForHandle,
} from "../../../convex/lib/accessPolicy.ts";
import {
  buildSnapshot,
  challengeExpiry,
  digitsLoginCode,
  loginStartDecision,
  loginVerifyDecision,
  MAX_VERIFY_ATTEMPTS,
  paymentApplyDecision,
  paymentsOwnedBy,
  phoneLast4,
  sessionExpiry,
  sessionLive,
  START_COOLDOWN_MS,
  storedHandle,
} from "../../../convex/lib/cabinetPolicy.ts";
import {
  isTestPhone,
  photonTestInbound,
  testPhoneFor,
  TEST_PHONE_PREFIX,
} from "../../../convex/lib/testTenantPolicy.ts";
import { parsePhotonInboundJson } from "../../../convex/lib/photonPolicy.ts";
import { dedicatedLineEnabled, identityCreateBody } from "../../../convex/lib/dedicatedLinePolicy.ts";
import { resolveTenantTz } from "../../../convex/lib/tzPolicy.ts";

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const MSK = "Europe/Moscow";
const TODAY = dayKey(NOW, MSK);
/** The moment Moscow and New York disagree about what day it is. */
const MSK_MIDNIGHT = Date.UTC(2026, 8, 17, 21, 30, 0);

/** A tenant bound well enough for the cabinet to send a login code. */
const BOUND = {
  phoneE164: "+79990000001",
  photonConversationId: "space-1",
  photonUserId: "photon-user-1",
};

export const MONEY: Journey[] = [
  {
    name: "Тридцать первое сообщение за день: платная стена ровно один раз",
    group: "money",
    steps: [
      {
        it: "бесплатный тариф — тридцать сообщений в день",
        got: () => msgAllowance(false, {}),
        want: 30,
      },
      {
        it: "тридцатое ещё проходит",
        got: () => paywallDecision({ count: 30, allowance: 30, dayKey: TODAY }),
        want: "allow",
      },
      {
        it: "тридцать первое встречает стену",
        got: () => paywallDecision({ count: 31, allowance: 30, dayKey: TODAY }),
        want: "paywall",
      },
      {
        it: "тридцать второе просто молчит — стену уже показали сегодня",
        got: () =>
          paywallDecision({ count: 32, allowance: 30, paywallSentDayKey: TODAY, dayKey: TODAY }),
        want: "drop",
      },
      {
        it: "завтра стена показывается заново",
        got: () =>
          paywallDecision({
            count: 31,
            allowance: 30,
            paywallSentDayKey: TODAY,
            dayKey: dayKey(NOW + 24 * 3600_000, MSK),
          }),
        want: "paywall",
      },
      {
        it: "на платном тарифе потолок другой",
        got: () => msgAllowance(true, {}),
        want: 500,
      },
      {
        it: "и до него ещё далеко",
        got: () => paywallDecision({ count: 31, allowance: 500, dayKey: TODAY }),
        want: "allow",
      },
      {
        it: "ссылка на оплату ведёт в сейф, а не на главную",
        got: () => payReturnUrl({ BRO_CABINET_BASE: "https://brobro.tech" }),
        contains: "vault.html",
      },
    ],
  },

  {
    name: "Счётчик не сошёлся: Bro не молчит и не повторяет стену",
    group: "money",
    steps: [
      {
        it: "учёт упал, стену сегодня ещё не слали — показываем её",
        got: () => inboundOnAccountingError({ alreadySentToday: false, marked: true }),
        want: { decision: "paywall" },
      },
      {
        it: "стену уже слали — второй раз не шлём",
        got: () => inboundOnAccountingError({ alreadySentToday: true, marked: true }),
        want: { decision: "drop" },
      },
      {
        it: "отметку поставить не удалось — тоже молчим, иначе стена пойдёт потоком",
        got: () => inboundOnAccountingError({ alreadySentToday: false, marked: false }),
        want: { decision: "drop" },
      },
      {
        it: "исключение из лимитера сводится к той же ветке",
        got: () =>
          inboundGateFromResult(undefined, new Error("rate limiter down"), {
            alreadySentToday: false,
            marked: true,
          }),
        want: { decision: "paywall" },
      },
      {
        it: "нормальный результат проходит как есть",
        got: () => inboundGateFromResult({ decision: "allow" }, null),
        want: { decision: "allow" },
      },
      {
        it: "браузерная квота при сбое учёта не запирает человека",
        got: () => browserGateFromResult(undefined, new Error("boom")),
        want: { allowed: BROWSER_JOBS_UNLIMITED },
      },
      {
        it: "и это то же решение, что и явная ветка «лимитер упал»",
        got: () => browserAllowedOnLimitError(),
        want: { allowed: BROWSER_JOBS_UNLIMITED },
      },
    ],
  },

  {
    name: "Браузерные поручения в закрытой бете не лимитированы — и это видно",
    group: "money",
    steps: [
      {
        it: "флаг беты включён",
        got: () => BROWSER_JOBS_UNLIMITED,
        want: true,
      },
      {
        it: "и бесплатный тариф получает тот же безлимит, что платный",
        got: () => browserAllowance(false, {}) === browserAllowance(true, {}),
        want: true,
      },
      {
        it: "потолок при этом не бесконечность, а конкретное число",
        got: () => browserAllowance(false, {}),
        want: ALLOWANCE_MAX,
      },
      {
        // `clampAllowance` warns on stderr when it clamps, which is right in
        // production and noise in a report — silenced for this one call.
        it: "слишком большое значение из окружения подрезается",
        got: () => {
          const warn = console.warn;
          console.warn = () => {};
          try {
            return clampAllowance(ALLOWANCE_MAX * 10);
          } finally {
            console.warn = warn;
          }
        },
        want: ALLOWANCE_MAX,
      },
      {
        it: "мусор в переменной окружения откатывается на значение по умолчанию",
        got: () => msgAllowance(false, { free: "не число" }),
        want: 30,
      },
      {
        it: "ключ окна лимитера строится из тенанта и календарного ключа",
        got: () => rateLimitPeriodKey("tenant-1", TODAY),
        want: `tenant-1:${TODAY}`,
      },
      {
        it: "истраченное считается как разница с потолком счётчика",
        got: () => usedCount(RATE_COUNTER_CAP - 7),
        want: 7,
      },
      {
        it: "отказ лимитера тратит на единицу больше — сообщение всё равно было",
        got: () => [consumeCount(true, 30), consumeCount(false, 30)],
        want: [30, 31],
      },
    ],
  },

  {
    name: "Оплатил — тариф продлился, а не начался заново",
    group: "money",
    steps: [
      {
        it: "без оплаты тариф бесплатный",
        got: () => isPaid(undefined, NOW),
        want: false,
      },
      {
        it: "истёкшая оплата — тоже",
        got: () => isPaid(NOW - 1, NOW),
        want: false,
      },
      {
        it: "первая оплата даёт месяц вперёд",
        got: () => extendPaidUntil(undefined, NOW) - NOW,
        want: 30 * 24 * 3600 * 1000,
      },
      {
        it: "оплата поверх действующей продлевает её, а не обнуляет",
        got: () => extendPaidUntil(NOW + 10 * 24 * 3600_000, NOW) - NOW,
        want: 40 * 24 * 3600 * 1000,
      },
      {
        it: "оплата поверх истёкшей считается от сегодня",
        got: () => extendPaidUntil(NOW - 10 * 24 * 3600_000, NOW) - NOW,
        want: 30 * 24 * 3600 * 1000,
      },
      {
        it: "тот же платёж дважды не применяется",
        got: () => [paymentApplyDecision(false), paymentApplyDecision(true)],
        want: ["apply", "skip"],
      },
      {
        it: "в кабинете чужие платежи не показываются",
        got: () =>
          paymentsOwnedBy("t1", [
            { tenantId: "t1", id: "p1" },
            { tenantId: "t2", id: "p2" },
          ]).map((p) => p.id),
        want: ["p1"],
      },
    ],
  },

  {
    name: "Человек переехал в другую зону — счётчики едут с ним, а не обнуляются",
    group: "money",
    steps: [
      {
        it: "дневной ключ считается в зоне человека: в полночь по Москве в Нью-Йорке ещё вчера",
        got: () => dayKey(MSK_MIDNIGHT, MSK) === dayKey(MSK_MIDNIGHT, "America/New_York"),
        want: false,
      },
      {
        it: "живой дневной счётчик переносится в новый ключ",
        got: () =>
          carryCountersOnTzChange({
            now: NOW,
            prevTz: MSK,
            nextTz: "Europe/Berlin",
            msgsDayKey: dayKey(NOW, MSK),
            msgsDayCount: 12,
          }).msgsDayCount,
        want: 12,
      },
      {
        it: "и ключ становится берлинским",
        got: () =>
          carryCountersOnTzChange({
            now: NOW,
            prevTz: MSK,
            nextTz: "Europe/Berlin",
            msgsDayKey: dayKey(NOW, MSK),
            msgsDayCount: 12,
          }).msgsDayKey,
        want: dayKey(NOW, "Europe/Berlin"),
      },
      {
        it: "протухший счётчик не воскресает — новый период начинается с нуля",
        got: () =>
          carryCountersOnTzChange({
            now: NOW,
            prevTz: MSK,
            nextTz: "Europe/Berlin",
            msgsDayKey: "2020-01-01",
            msgsDayCount: 29,
          }).msgsDayCount,
        want: 0,
      },
      {
        it: "уже показанная сегодня стена переезжает вместе с днём",
        got: () =>
          carryCountersOnTzChange({
            now: NOW,
            prevTz: MSK,
            nextTz: "Europe/Berlin",
            paywallSentDayKey: dayKey(NOW, MSK),
          }).paywallSentDayKey,
        want: dayKey(NOW, "Europe/Berlin"),
      },
      {
        it: "месячный ключ браузерных поручений тоже переезжает",
        got: () =>
          carryCountersOnTzChange({ now: NOW, prevTz: MSK, nextTz: "Europe/Berlin" }).browserMonthKey,
        want: monthKey(NOW, "Europe/Berlin"),
      },
      {
        it: "старый счётчик и компонентный складываются, а не затирают друг друга",
        got: () => effectiveUsedCount(5, legacyUsedForPeriod("k", 7, "k")),
        want: 12,
      },
      {
        it: "чужой период в эту сумму не попадает",
        got: () => legacyUsedForPeriod("вчера", 7, "сегодня"),
        want: 0,
      },
      {
        it: "выдуманная зона откатывается на Москву — счётчики не теряются",
        got: () => resolveTenantTz("Мордор/Столица"),
        want: MSK,
      },
    ],
  },

  {
    name: "Тестовый тенант не тратит ничьи деньги",
    group: "money",
    steps: [
      {
        it: "номер сценария лежит в вымышленном диапазоне",
        got: () => testPhoneFor("billing").startsWith(TEST_PHONE_PREFIX),
        want: true,
      },
      {
        it: "и распознаётся как тестовый",
        got: () => isTestPhone(testPhoneFor("billing")),
        want: true,
      },
      {
        it: "настоящий номер — нет",
        got: () => isTestPhone("+79990000001"),
        want: false,
      },
      {
        it: "тестовый inbound собирается тем же кодом, что читает прод",
        got: () =>
          parsePhotonInboundJson(
            photonTestInbound({ phone: testPhoneFor("billing"), text: "купи кроссовки" }),
          )?.text,
        want: "купи кроссовки",
      },
      {
        it: "и приходит по синему каналу, а не как SMS",
        got: () =>
          JSON.stringify(photonTestInbound({ phone: testPhoneFor("billing"), text: "привет" })),
        contains: "iMessage",
      },
      {
        it: "префикс диапазона — константа, а не переменная окружения",
        got: () => TEST_PHONE_PREFIX,
        want: "+1555555",
      },
    ],
  },

  {
    name: "Новый человек получает хендл, и хендлов не бесконечно",
    group: "money",
    steps: [
      {
        it: "хендл имеет фиксированную форму",
        got: () => isValidHandle(makeHandle(() => 0.5)),
        want: true,
      },
      {
        it: "чужая форма хендлом не считается",
        got: () => isValidHandle("bro-ЖЖЖЖЖЖЖЖ"),
        want: false,
      },
      {
        it: "кабинет принимает только валидный хендл из localStorage",
        got: () => [storedHandle("bro-ab12cd34"), storedHandle("мусор")],
        want: ["bro-ab12cd34", null],
      },
      {
        it: "вебхук тенанта несёт его хендл в query",
        got: () => webhookUrlForHandle("https://bro.example/webhooks/imessage", "bro-ab12cd34"),
        contains: "h=bro-ab12cd34",
      },
      {
        it: "у деплоя есть потолок числа идентичностей",
        got: () => identityCap(undefined),
        want: DEFAULT_IDENTITY_CAP,
      },
      {
        it: "и он действительно упирается",
        got: () => identityCapReached(100, 100),
        want: true,
      },
      {
        it: "создание идентичностей в час тоже ограничено — страница /access без логина",
        got: () => accessCreatesPerHour(undefined),
        want: DEFAULT_ACCESS_CREATES_PER_HOUR,
      },
      {
        it: "мусор в переменной откатывается на значение по умолчанию, а не на ноль",
        got: () => accessCreatesPerHour("сколько-нибудь"),
        want: DEFAULT_ACCESS_CREATES_PER_HOUR,
      },
      {
        it: "iOS-агент распознаётся, хотя его и можно подделать",
        got: () => [isIosUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"), isIosUserAgent("curl/8")],
        want: [true, false],
      },
    ],
  },

  {
    name: "Вход в кабинет: код в чат, пять попыток, тридцать дней сессии",
    group: "money",
    steps: [
      {
        it: "неизвестный хендл кода не получает",
        got: () => loginStartDecision({ tenant: null, now: NOW }),
        want: "unknown",
      },
      {
        it: "тенант без телефона — тоже",
        got: () => loginStartDecision({ tenant: { photonConversationId: "s1", photonUserId: "u1" }, now: NOW }),
        want: "unbound",
      },
      {
        it: "привязанный тенант получает код",
        got: () => loginStartDecision({ tenant: BOUND, now: NOW }),
        want: "ok",
      },
      {
        it: "но не чаще раза в сорок пять секунд",
        got: () => loginStartDecision({ tenant: BOUND, lastChallengeAt: NOW - 10_000, now: NOW }),
        want: "cooldown",
      },
      {
        it: "после остывания — снова можно",
        got: () =>
          loginStartDecision({ tenant: BOUND, lastChallengeAt: NOW - START_COOLDOWN_MS - 1, now: NOW }),
        want: "ok",
      },
      {
        it: "вставленный «123 456» всё ещё код",
        got: () => digitsLoginCode("123 456"),
        want: "123456",
      },
      {
        it: "а пятизначное число — нет",
        got: () => digitsLoginCode("12345"),
        want: null,
      },
      {
        it: "верный код в срок пускает",
        got: () =>
          loginVerifyDecision({ now: NOW, expiresAt: challengeExpiry(NOW), attempts: 0, codeMatch: true }),
        want: { kind: "ok" },
      },
      {
        it: "неверный — считает оставшиеся попытки",
        got: () =>
          loginVerifyDecision({ now: NOW, expiresAt: challengeExpiry(NOW), attempts: 0, codeMatch: false }),
        want: { kind: "wrong", attemptsLeft: MAX_VERIFY_ATTEMPTS - 1 },
      },
      {
        it: "после пяти попыток запирает даже верный код",
        got: () =>
          loginVerifyDecision({
            now: NOW,
            expiresAt: challengeExpiry(NOW),
            attempts: MAX_VERIFY_ATTEMPTS,
            codeMatch: true,
          }),
        want: { kind: "locked" },
      },
      {
        it: "просроченный код не пускает, сколько бы попыток ни осталось",
        got: () => loginVerifyDecision({ now: NOW, expiresAt: NOW - 1, attempts: 0, codeMatch: true }),
        want: { kind: "expired" },
      },
      {
        it: "сессия живёт тридцать дней",
        got: () => sessionExpiry(NOW) - NOW,
        want: 30 * 24 * 3600 * 1000,
      },
      {
        it: "и по истечении перестаёт быть живой",
        got: () => [sessionLive(NOW + 1, NOW), sessionLive(NOW - 1, NOW)],
        want: [true, false],
      },
    ],
  },

  {
    name: "Кабинет показывает человеку его расход, а не чужой и не выдуманный",
    group: "money",
    steps: [
      {
        it: "бесплатный тариф так и называется",
        got: () =>
          buildSnapshot({
            handle: "bro-ab12cd34",
            phoneE164: "+79990000001",
            paid: false,
            msgsUsed: 12,
            msgsAllowance: 30,
            msgsDayKey: TODAY,
            browserUsed: 2,
            browserAllowance: ALLOWANCE_MAX,
            browserMonthKey: monthKey(NOW, MSK),
            payments: [],
          }).plan,
        want: "free",
      },
      {
        it: "телефон показывается последними четырьмя цифрами, а не целиком",
        got: () => phoneLast4("+79990000001"),
        want: "0001",
      },
      {
        it: "и полного номера в снимке нет",
        got: () =>
          buildSnapshot({
            handle: "bro-ab12cd34",
            phoneE164: "+79990000001",
            paid: false,
            msgsUsed: 12,
            msgsAllowance: 30,
            msgsDayKey: TODAY,
            browserUsed: 2,
            browserAllowance: ALLOWANCE_MAX,
            browserMonthKey: monthKey(NOW, MSK),
            payments: [],
          }),
        lacks: "+79990000001",
      },
      {
        it: "у тенанта без телефона это честно отражено",
        got: () =>
          buildSnapshot({
            handle: "bro-ab12cd34",
            paid: false,
            msgsUsed: 0,
            msgsAllowance: 30,
            msgsDayKey: TODAY,
            browserUsed: 0,
            browserAllowance: ALLOWANCE_MAX,
            browserMonthKey: monthKey(NOW, MSK),
            payments: [],
          }).phoneBound,
        want: false,
      },
      {
        it: "когда Bro ничем не занят, это написано словами, а не пустой строкой",
        got: () =>
          buildSnapshot({
            handle: "bro-ab12cd34",
            paid: false,
            msgsUsed: 0,
            msgsAllowance: 30,
            msgsDayKey: TODAY,
            browserUsed: 0,
            browserAllowance: ALLOWANCE_MAX,
            browserMonthKey: monthKey(NOW, MSK),
            payments: [],
          }).browserJob.label,
        contains: "ничего не делает",
      },
      {
        it: "профиль браузера по умолчанию считается отсутствующим, а не готовым",
        got: () =>
          buildSnapshot({
            handle: "bro-ab12cd34",
            paid: false,
            msgsUsed: 0,
            msgsAllowance: 30,
            msgsDayKey: TODAY,
            browserUsed: 0,
            browserAllowance: ALLOWANCE_MAX,
            browserMonthKey: monthKey(NOW, MSK),
            payments: [],
          }).browserProfileStatus,
        want: "missing",
      },
    ],
  },

  {
    name: "Выделенный номер: выключен по умолчанию и включается явно",
    group: "money",
    steps: [
      {
        it: "без переменной окружения выключен",
        got: () => dedicatedLineEnabled(undefined),
        want: false,
      },
      {
        it: "мусор его не включает",
        got: () => dedicatedLineEnabled("может быть"),
        want: false,
      },
      {
        it: "явное «1» включает",
        got: () => dedicatedLineEnabled("1"),
        want: true,
      },
      {
        it: "тело запроса на идентичность несёт хендл тенанта",
        got: () => JSON.stringify(identityCreateBody({ handle: "bro-ab12cd34", displayName: "Bro", dedicatedLine: false })),
        contains: "bro-ab12cd34",
      },
    ],
  },
];
