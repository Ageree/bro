/**
 * Group 2 — mail and one-time codes.
 *
 * Every login Bro drives ends at the same fork: the code lands either in the
 * mailbox Bro owns (`[event:mail]` → `otp_lookup`) or in the human's chat. The
 * stories below walk both, plus the four ways the fork goes wrong: no letter at
 * all, two fresh codes from two senders, a marketing blast that merely contains
 * digits, and a code that has already expired.
 *
 * The expensive failure here is not "no code found" — it is a WRONG code typed
 * into a live checkout, so the ambiguous and stale paths get as many steps as
 * the happy one.
 */

import type { Journey } from "./runner.ts";
import {
  attachMailToJob,
  formatMailWake,
  isEmailAddr,
  mailBelongsToTenant,
  mailWebhookUrl,
  normalizeEmail,
} from "../../../convex/lib/mailPolicy.ts";
import {
  attachOtpToWake,
  candidatesFromMail,
  extractOtpCodes,
  formatOtpLookup,
  isOtpChallenge,
  looksLikeOtpMail,
  otpFromEventMail,
  otpSearchQuery,
  OTP_CHECK_IN_MINUTES,
  OTP_WINDOW_MS,
  pickOtp,
  shouldIngestInkboxMail,
} from "../../../agent/lib/otp-policy.ts";
import {
  CHAT_CODE_ACK,
  decideCloudInject,
  extractChatCode,
  injectAckText,
  injectQueueInterrupt,
  injectQueueText,
  isChatCodeMessage,
  NO_LIVE_RUN_TEXT,
  pageWaitsForCode,
  cloudInjectAttribute,
  cloudInjectInstruction,
} from "../../../convex/lib/browserInjectPolicy.ts";
import { humanLineForNeed, parseCloudOutcome } from "../../../convex/lib/browserOutcomePolicy.ts";
import { defaultCheckInMinutes, nudgePrompt, shouldNudge } from "../../../convex/lib/jobNudgePolicy.ts";
import { turnVoice } from "../../../agent/lib/turn-voice.ts";
import { scrubSecrets } from "../../../convex/lib/secretScrub.ts";

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

/** A live Cloud session parked on the WB login code screen. */
const WB_CODE_PAGE = {
  sessionId: "sess-wb",
  runId: "run-wb",
  status: "running",
  storedTask: "купи кроссовки на вб",
  pageUrl: "https://passport.wildberries.ru/auth/code",
  need: "sms_code",
  browserListed: true,
  now: NOW,
};

const WB_MAIL = {
  from: "noreply@wb.ru",
  subject: "Код подтверждения",
  body: "Ваш код: 482911. Никому его не сообщайте.",
  atMs: NOW,
};

const BANK_MAIL = {
  from: "noreply@tinkoff.ru",
  subject: "Код для входа",
  body: "Код: 771122",
  atMs: NOW,
};

const NEWSLETTER = {
  from: "news@shop.ru",
  subject: "Скидки до 70% уже сегодня",
  body: "Промокод SALE70 действует до 30 сентября. Отписаться можно внизу письма.",
  atMs: NOW,
};

export const MAIL: Journey[] = [
  {
    name: "Код приходит на ящик Bro, а не в чат — письмо, поиск, молчаливый ввод",
    group: "mail",
    steps: [
      {
        it: "«войди на вб» — обычное поручение, голос не ограничен",
        got: () =>
          turnVoice({
            origin: "human",
            shortAck: false,
            waitingForHuman: false,
            jobCheck: false,
            dueNudges: 0,
            browserPollForceSpeak: false,
          }),
        want: "free",
      },
      {
        it: "Cloud-прогон встал и сам сказал, чего ему не хватает",
        got: () => parseCloudOutcome("СДЕЛАНО: нет\nНУЖНО: email_code\nДЕТАЛИ: код ушёл на почту").needs,
        want: "email_code",
      },
      {
        it: "человеку уходит человеческая строка, а не «needs user input»",
        got: () => humanLineForNeed("email_code"),
        lacks: "email_code",
      },
      {
        it: "письмо с кодом приходит на ящик Bro и попадает в ход как событие",
        got: () =>
          formatMailWake({
            jobId: "job-1",
            messageId: "m-1",
            threadId: "t-1",
            from: WB_MAIL.from,
            subject: WB_MAIL.subject,
            body: WB_MAIL.body,
          }),
        contains: "[event:mail]",
      },
      {
        it: "это письмо распознаётся как письмо с кодом",
        got: () => looksLikeOtpMail(WB_MAIL),
        want: true,
      },
      {
        it: "код достаётся из тела письма",
        got: () => extractOtpCodes(WB_MAIL.body),
        want: ["482911"],
      },
      {
        it: "выбор однозначный — один свежий код высокой уверенности",
        got: () => pickOtp(candidatesFromMail("bro_mail", WB_MAIL), NOW).status,
        want: "found",
      },
      {
        it: "код приклеивается прямо к событию — модели не надо его выковыривать",
        got: () =>
          attachOtpToWake(
            formatMailWake({
              jobId: "job-1",
              messageId: "m-1",
              threadId: "t-1",
              from: WB_MAIL.from,
              subject: WB_MAIL.subject,
              body: WB_MAIL.body,
            }),
            NOW,
          ),
        contains: "otp: 482911",
      },
      {
        it: "и уезжает в живую вкладку, а не пересылается человеку",
        got: () => injectQueueText({ kind: "code", humanText: "482911", code: "482911" }),
        contains: "Введи его в поле кода",
      },
      {
        it: "письмо с кодом в архив не кладётся — одноразовому коду там не место",
        got: () => shouldIngestInkboxMail(WB_MAIL),
        want: false,
      },
    ],
  },

  {
    name: "Код из банка приходит в чат, пока открыта живая вкладка",
    group: "mail",
    steps: [
      {
        it: "«купи кроссовки на вб» — новое поручение, не инъекция в сессию",
        got: () => decideCloudInject("купи кроссовки на вб", {}).kind,
        want: null,
      },
      {
        it: "браузер встал на странице ввода кода",
        got: () => pageWaitsForCode(WB_CODE_PAGE.pageUrl),
        want: true,
      },
      {
        it: "«482911» — это код, а не номер и не пароль",
        got: () => isChatCodeMessage("482911"),
        want: true,
      },
      {
        it: "решение по ходу: это код для открытой сессии",
        got: () => decideCloudInject("482911", WB_CODE_PAGE),
        want: { kind: "code", code: "482911" },
      },
      {
        it: "канал штампует ход, чтобы модель не переформулировала код",
        got: () => cloudInjectAttribute("482911"),
        want: { cloudInject: "code", cloudInjectText: "482911" },
      },
      {
        it: "первая строка человеку — ровно «ввожу код»",
        got: () => injectAckText("code"),
        want: CHAT_CODE_ACK,
      },
      {
        it: "инструкция модели запрещает цитировать цифры",
        got: () => cloudInjectInstruction("code", true),
        contains: "Do not quote the digits",
      },
      {
        it: "код не прерывает прогон — он и есть ожидаемый вход",
        got: () => injectQueueInterrupt("code"),
        want: false,
      },
      {
        it: "ход человека остаётся обычным ходом, молчать тут нельзя",
        got: () =>
          turnVoice({
            origin: "human",
            shortAck: false,
            waitingForHuman: false,
            jobCheck: false,
            dueNudges: 0,
            browserPollForceSpeak: false,
          }),
        want: "free",
      },
      {
        it: "прогон дожал заказ — номер есть, человеку есть что сказать",
        got: () => parseCloudOutcome("СДЕЛАНО: купил кроссовки\nЗАКАЗ: 123\nНУЖНО: none").orderId,
        want: "123",
      },
    ],
  },

  {
    name: "Код прислали, а живой вкладки уже нет — новый поиск не начинается",
    group: "mail",
    steps: [
      {
        it: "код по-прежнему распознаётся кодом",
        got: () => isChatCodeMessage("482911"),
        want: true,
      },
      {
        it: "сессии нет — решение всё равно «код», чтобы ход не ушёл в поиск",
        got: () => decideCloudInject("482911", {}).kind,
        want: "code",
      },
      {
        it: "но инструкция для неживой сессии прямо запрещает начинать поиск",
        got: () => cloudInjectInstruction("code", false),
        contains: "Do not start a search",
      },
      {
        it: "и у продукта есть готовая честная фраза на этот случай",
        got: () => NO_LIVE_RUN_TEXT,
        contains: "уже закрылась",
      },
      {
        it: "а пароль сайта не просят ни в одной из веток",
        got: () => cloudInjectInstruction("code", false),
        contains: "Never ask for a site password",
      },
    ],
  },

  {
    name: "Письма с кодом нет — один вопрос в тред и джоб на ожидание почты",
    group: "mail",
    steps: [
      {
        it: "прогон говорит, что ждёт код с почты",
        got: () => isOtpChallenge("needs user input: нужен код из письма"),
        want: true,
      },
      {
        it: "в ящике ничего свежего — поиск пуст",
        got: () => pickOtp([], NOW).status,
        want: "missing",
      },
      {
        it: "тул отдаёт человекочитаемую подсказку, а не пустоту",
        got: () => formatOtpLookup({ status: "missing" }).hint,
        contains: "спроси в треде",
      },
      {
        it: "поисковый запрос по архиву строится с подсказкой мерчанта",
        got: () => otpSearchQuery("wildberries"),
        contains: "wildberries",
      },
      {
        it: "ожидание почты проверяется каждые три минуты",
        got: () => OTP_CHECK_IN_MINUTES,
        want: 3,
      },
      {
        it: "джоб на письмо по умолчанию просыпается через 45 минут",
        got: () => defaultCheckInMinutes("email"),
        want: 45,
      },
      {
        it: "через 50 минут ожидания нудж созрел",
        got: () => shouldNudge({ waitingFor: "email", waitingSince: NOW - 50 * 60_000, now: NOW }),
        want: true,
      },
      {
        it: "и человек получает строку про письмо, а не молчание",
        got: () => nudgePrompt({ waitingFor: "email", goal: "код от вб" }),
        contains: "жду письмо",
      },
      {
        it: "созревший нудж делает ход обязательным к ответу",
        got: () =>
          turnVoice({
            origin: "wakeup",
            shortAck: false,
            waitingForHuman: false,
            jobCheck: true,
            dueNudges: 1,
            browserPollForceSpeak: false,
          }),
        want: "must_speak",
      },
    ],
  },

  {
    name: "Два свежих кода от разных отправителей — Bro не угадывает",
    group: "mail",
    steps: [
      {
        it: "оба письма читаются как письма с кодом",
        got: () => [looksLikeOtpMail(WB_MAIL), looksLikeOtpMail(BANK_MAIL)],
        want: [true, true],
      },
      {
        it: "оба кандидата высокой уверенности",
        got: () =>
          [...candidatesFromMail("bro_mail", WB_MAIL), ...candidatesFromMail("bro_mail", BANK_MAIL)].map(
            (c) => c.confidence,
          ),
        want: ["high", "high"],
      },
      {
        it: "без подсказки выбор неоднозначен — молчим, а не вводим случайный",
        got: () =>
          pickOtp(
            [...candidatesFromMail("bro_mail", WB_MAIL), ...candidatesFromMail("bro_mail", BANK_MAIL)],
            NOW,
          ).status,
        want: "ambiguous",
      },
      {
        it: "человеку говорят про несколько кодов, а не выдают один",
        got: () => formatOtpLookup({ status: "ambiguous", hits: [] }).hint,
        contains: "несколько свежих кодов",
      },
      {
        it: "но если известно, что вход на вб, подсказка снимает спор",
        got: () =>
          pickOtp(
            [...candidatesFromMail("bro_mail", WB_MAIL), ...candidatesFromMail("bro_mail", BANK_MAIL)],
            NOW,
            "wb",
          ).status,
        want: "found",
      },
      {
        it: "и это именно код вб, а не банка",
        got: () => {
          const pick = pickOtp(
            [...candidatesFromMail("bro_mail", WB_MAIL), ...candidatesFromMail("bro_mail", BANK_MAIL)],
            NOW,
            "wb",
          );
          return pick.status === "found" ? pick.hit.code : null;
        },
        want: "482911",
      },
    ],
  },

  {
    name: "Рассылка с промокодом — не код и не повод писать человеку",
    group: "mail",
    steps: [
      {
        it: "письмо не похоже на письмо с кодом",
        got: () => looksLikeOtpMail(NEWSLETTER),
        want: false,
      },
      {
        it: "и кандидатов из него не строится",
        got: () => candidatesFromMail("bro_mail", NEWSLETTER),
        want: [],
      },
      {
        it: "даже в формате события кода в нём не находится",
        got: () =>
          otpFromEventMail(
            formatMailWake({
              jobId: null,
              messageId: "m-2",
              threadId: null,
              from: NEWSLETTER.from,
              subject: NEWSLETTER.subject,
              body: NEWSLETTER.body,
            }),
            NOW,
          ).status,
        want: "missing",
      },
      {
        it: "зато в архив такое письмо кладётся — это обычная почта",
        got: () => shouldIngestInkboxMail(NEWSLETTER),
        want: true,
      },
    ],
  },

  {
    name: "Код протух — пятнадцатиминутное окно закрылось",
    group: "mail",
    steps: [
      {
        it: "окно жизни кода — пятнадцать минут",
        got: () => OTP_WINDOW_MS,
        want: 15 * 60_000,
      },
      {
        it: "код четырнадцатиминутной давности ещё годится",
        got: () => pickOtp(candidatesFromMail("bro_mail", { ...WB_MAIL, atMs: NOW - 14 * 60_000 }), NOW).status,
        want: "found",
      },
      {
        it: "двадцатиминутной — уже нет",
        got: () => pickOtp(candidatesFromMail("bro_mail", { ...WB_MAIL, atMs: NOW - 20 * 60_000 }), NOW).status,
        want: "missing",
      },
      {
        it: "письмо без времени тоже не годится — свежесть недоказуема",
        got: () => pickOtp(candidatesFromMail("bro_mail", { ...WB_MAIL, atMs: undefined }), NOW).status,
        want: "missing",
      },
    ],
  },

  {
    name: "Письмо с номером заказа рядом с кодом — цифры заказа не уезжают как код",
    group: "mail",
    steps: [
      {
        it: "в чате «код 482913, заказ 55081234» даёт именно код",
        got: () => extractChatCode("код 482913, заказ 55081234"),
        want: "482913",
      },
      {
        it: "а «заказ 55081234» без кода — не код вовсе",
        got: () => isChatCodeMessage("заказ 55081234"),
        want: false,
      },
      {
        it: "цена «1500 руб» тоже не код",
        got: () => isChatCodeMessage("1500 руб"),
        want: false,
      },
      {
        it: "год «2026» не код",
        got: () => extractChatCode("2026"),
        want: null,
      },
      {
        it: "в письме про заказ без кодовых слов код не выкапывается",
        got: () => extractOtpCodes("Ваш заказ 55081234 на сумму 4990 руб собран"),
        want: [],
      },
    ],
  },

  {
    name: "Письмо пришло не тому человеку — почта чужого тенанта не читается",
    group: "mail",
    steps: [
      {
        it: "адрес тенанта нормализуется до сравнения",
        got: () => normalizeEmail("  Me@Bro.Tech "),
        want: "me@bro.tech",
      },
      {
        it: "письмо на его адрес — его",
        got: () => mailBelongsToTenant("me@bro.tech", null, ["ME@BRO.TECH"], null),
        want: true,
      },
      {
        it: "письмо на чужой адрес — не его",
        got: () => mailBelongsToTenant("me@bro.tech", null, ["someone@else.ru"], null),
        want: false,
      },
      {
        it: "копия на его адрес считается",
        got: () => mailBelongsToTenant("me@bro.tech", null, ["other@x.ru"], ["me@bro.tech"]),
        want: true,
      },
      {
        it: "тенант без почты не владеет ничем",
        got: () => mailBelongsToTenant(undefined, "me@bro.tech", ["me@bro.tech"], null),
        want: false,
      },
      {
        it: "мусор вместо адреса адресом не считается",
        got: () => isEmailAddr("не-почта"),
        want: false,
      },
    ],
  },

  {
    name: "Письмо цепляется к джобу: по треду точно, по угадыванию — никогда",
    group: "mail",
    steps: [
      {
        it: "один ждущий почту джоб — письмо очевидно его",
        got: () => attachMailToJob([{ id: "j1", status: "waiting", waitingFor: "email" }], null),
        want: "j1",
      },
      {
        it: "два ждущих джоба без треда — не гадаем",
        got: () =>
          attachMailToJob(
            [
              { id: "j1", status: "waiting", waitingFor: "email" },
              { id: "j2", status: "waiting", waitingFor: "email" },
            ],
            null,
          ),
        want: null,
      },
      {
        it: "тред письма разрешает спор однозначно",
        got: () =>
          attachMailToJob(
            [
              { id: "j1", status: "waiting", waitingFor: "email", emailThreadId: "t-1" },
              { id: "j2", status: "waiting", waitingFor: "email" },
            ],
            "t-1",
          ),
        want: "j1",
      },
      {
        it: "джоб, который ждёт человека, к письму не цепляется",
        got: () => attachMailToJob([{ id: "j1", status: "waiting", waitingFor: "human" }], null),
        want: null,
      },
    ],
  },

  {
    name: "Ящик Bro стоит на своём вебхуке, а не на iMessage-эндпоинте",
    group: "mail",
    steps: [
      {
        it: "URL почтового вебхука выводится из iMessage-базы",
        got: () => mailWebhookUrl("https://bro.tech/webhooks/imessage"),
        contains: "/webhooks/mail",
      },
      {
        it: "iMessage-путь при этом не остаётся",
        got: () => mailWebhookUrl("https://bro.tech/webhooks/imessage"),
        lacks: "imessage",
      },
      {
        it: "хендл тенанта едет в query — письмо знает, чьё оно",
        got: () => mailWebhookUrl("https://bro.tech/webhooks/imessage", "bro-ab12cd34"),
        contains: "h=bro-ab12cd34",
      },
    ],
  },

  {
    name: "В письме лежит пароль — до вендора он не доезжает",
    group: "mail",
    steps: [
      {
        it: "письмо с паролем чистится последним рубежом",
        got: () => scrubSecrets("В письме: пароль от вб: зайка2024"),
        lacks: "зайка2024",
      },
      {
        it: "метка остаётся — человеку видно, что было вырезано",
        got: () => scrubSecrets("пароль от вб: зайка2024"),
        contains: "[password]",
      },
      {
        it: "тот же текст, отправленный человеком в чат, не становится инъекцией",
        got: () => decideCloudInject("пароль от вб: зайка2024", WB_CODE_PAGE).kind,
        want: null,
      },
      {
        it: "и не штампуется на ход, чтобы не всплыть следующим ходом",
        got: () => cloudInjectAttribute("пароль от вб: зайка2024"),
        want: {},
      },
    ],
  },
];
