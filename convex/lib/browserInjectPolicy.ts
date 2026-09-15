/**
 * Mid-run iMessage → live Browser Use Cloud session.
 * Only text relevant to that session is injected (OTP, wait, address/correction).
 * Unrelated chat stays a normal Bro reply. Site passwords never go in iMessage.
 */

import {
  isLoginVaultTask,
  isLoginWaitTask,
} from "./browserProfilePolicy.ts";
import { DONE } from "./browserFollowPolicy.ts";

export const INJECT_MARK = "[bro-inject]";

export const CHAT_CODE_ACK = "ввожу код";
export const CHAT_INJECT_ACK = "ввожу";
export const CHAT_WAIT_ACK = "подожду";

export const NO_LIVE_RUN_TEXT =
  "Сейчас нет открытой сессии в браузере, которая ждёт этот код. Если нужно войти заново — напиши.";

export const INJECT_NO_PASSWORD_HINT =
  "Не проси пароль сайта в чат. Код или уточнение введи в живую Cloud-сессию. Если сессии нет — скажи об этом, не начинай новый поиск.";

const ACTIVE = new Set([
  "queued",
  "pending",
  "running",
  "started",
  "in_progress",
  "working",
  "processing",
]);

const YEAR = /^(?:19|20)\d{2}$/;
const FRESH_ERRAND =
  /купи|купить|найди|найти|закаж|заказ|wb|wildberries|ozon|озон|wildberries\.|ozon\.ru|забронир|брон|запиш|запис|запись|столик|ресторан|врач|стоматолог|клиник|салон|такси|доставк|отель|билет|вызов|оформ|аренд/i;

const WAIT_HEAD =
  /^(подожди|подождите|погоди|погодите|стой|стойте|wait|hold on|секунду|минутку|не нажимай(?:те)? пока|не сейчас)(?=$|[\s.!?…,])/;

const CORRECTION =
  /адрес|улиц|проспект|переул|набережн|шоссе|метро|аэропорт|вокзал|домой|на работу|офис|подъезд|квартир|кв\.?|корп|домофон|пвз|пункт выдач|размер|цвет|не туда|не этот|не те|другой адрес|другой пвз|исправ|поправ|откуда|куда|через \d|в \d{1,2}:\d{2}/i;

const STREET_LINE = /[A-Za-zА-Яа-яё]{3,}\s+\d{1,3}[а-яa-z]?/i;

const CODE_WRAPPER = /^(?:код|воткод|смс|sms|otp|push|пуш)$/i;

const OTP_RESULT =
  /needs user input:|код из|смс[- ]?код|sms|one[-\s]?time|passcode|пуш|push (?:code|approval)|verification code|live-url|live url|liveUrl/i;

export type CloudInjectKind = "code" | "wait" | "correction" | "steer";

// Pure chatter and status questions to Bro must never be docked into a live
// Cloud session. Everything else the human sends while a session is live is
// treated as a relevant steer (extra instruction / detail for the errand).
const SMALLTALK =
  /^(привет\w*|здоров\w*|хай|ку|hi|hello|hey|спасибо( большое)?|спс|благодар\w*|пасиб\w*|ок\w*|okay?|ok|да|нет|неа|ага|угу|понял\w*|ясно|хорошо|ладно|класс|супер|отлично|круто|збс|топ|thanks|thx|ty|лол|ok\b|👍|🙏|❤️|😂|🔥|😊)\s*[.!?…]*$/iu;

const STATUS_Q =
  /(что там|как там|как дела|ну как|что по|есть новости|готово|status|статус|где (мой )?заказ|ты (тут|здесь|там)|получилось|сделал(а)?\??$|ну что)/i;

/** A message worth docking into a live Cloud session as a steer, sans session context. */
export function steerCandidate(text: string): boolean {
  const t = text.trim().normalize("NFC").replace(/ё/gi, "е");
  if (!t || t.length > 400) return false;
  if (looksLikePasswordDump(t)) return false;
  if (SMALLTALK.test(t)) return false;
  if (STATUS_Q.test(t)) return false;
  // Codes / «подожди» / corrections are their own kinds.
  if (isChatCodeMessage(t) || isWaitInject(t) || looksLikeCorrectionText(t)) {
    return false;
  }
  // A brand-new, unrelated errand opens a fresh session, it is not a steer.
  if (looksLikeFreshErrand(t)) return false;
  return true;
}

/** Steer only fires while a Cloud errand session is actually on record. */
export function looksLikeSteer(
  text: string,
  storedTask?: string | null,
): boolean {
  return steerCandidate(text) && isBroCloudTask(storedTask);
}

export type CloudInjectDecision = {
  kind: CloudInjectKind | null;
  code?: string;
};

export type CloudInjectAttrs = {
  status?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  storedTask?: string | null;
  startedAt?: number;
  now?: number;
  pageUrl?: string;
  result?: string | null;
  browserListed?: boolean;
};

export function isInjectTask(task: string | undefined): boolean {
  return typeof task === "string" && task.trim().startsWith(INJECT_MARK);
}

export function isActiveCloudStatus(status: string | undefined | null): boolean {
  return ACTIVE.has((status ?? "").trim().toLowerCase());
}

export function isDoneCloudStatus(status: string | undefined | null): boolean {
  return DONE.has((status ?? "").trim().toLowerCase());
}

export function looksLikePasswordDump(text: string): boolean {
  const t = text.trim();
  if (t.length < 8 || t.length > 64) return false;
  if (/\s/.test(t) || /^https?:\/\//i.test(t)) return false;
  return /[A-Za-z]/.test(t) && /\d/.test(t) && /[^A-Za-z0-9]/.test(t);
}

export function looksLikeFreshErrand(text: string): boolean {
  return FRESH_ERRAND.test(text.trim());
}

export function extractChatCode(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 80) return null;
  let normalized = t;
  normalized = normalized.replace(/\b(\d{3})[ ](\d{3})\b/g, "$1$2");
  normalized = normalized.replace(/\b(\d{2})[ ](\d{2})[ ](\d{2})\b/g, "$1$2$3");
  const digitsOnly = t.replace(/\D/g, "");
  if (/^\d{4,8}$/.test(digitsOnly) && !YEAR.test(digitsOnly)) {
    return digitsOnly;
  }
  const found: string[] = [];
  const re = /\b(\d{4,8})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized))) {
    const code = m[1]!;
    if (YEAR.test(code)) continue;
    if (!found.includes(code)) found.push(code);
  }
  return found.length === 1 ? found[0] : null;
}

export function isChatCodeMessage(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (looksLikePasswordDump(t) || looksLikeFreshErrand(t)) return false;
  const code = extractChatCode(t);
  if (!code) return false;
  const extra = t
    .replace(/\d/g, "")
    .replace(/[\s:.\-–—]/g, "")
    .replace(/ё/gi, "е")
    .toLowerCase();
  if (!extra || CODE_WRAPPER.test(extra)) return true;
  return /код|otp|sms|смс|пуш|push/i.test(t);
}

export function isWaitInject(text: string): boolean {
  const t = text
    .trim()
    .normalize("NFC")
    .replace(/ё/gi, "е")
    .toLowerCase()
    .replace(/[.!?…]+$/u, "")
    .trim();
  if (!t || t.length > 80) return false;
  if (looksLikeFreshErrand(text)) return false;
  return WAIT_HEAD.test(t);
}

export function correctionFitsTask(
  text: string,
  storedTask?: string | null,
): boolean {
  if (!looksLikeCorrectionText(text) || !isBroCloudTask(storedTask)) return false;
  const task = storedTask ?? "";
  if (isLoginWaitTask(task) || isLoginVaultTask(task)) return false;
  const taxi =
    /такси|taxi|доставк|адрес|куда|откуда|забронир|столик|врач|салон/i.test(
      task,
    );
  const shop =
    /wb|wildberries|ozon|озон|\bвб\b|\bwb\b|размер|пвз|обув|кроссов/i.test(task);
  if (
    taxi &&
    (/адрес|домой|работу|куда|откуда|улиц|не туда|метро|аэропорт|вокзал|подъезд|квартир|кв|офис|через \d|в \d{1,2}:/i.test(
      text,
    ) ||
      STREET_LINE.test(text))
  ) {
    return true;
  }
  if (shop && /размер|пвз|пункт|цвет|не те|не этот|другой пвз/i.test(text)) {
    return true;
  }
  return !taxi && !shop;
}

export function looksLikeCorrectionText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 240) return false;
  if (isChatCodeMessage(t) || isWaitInject(t) || looksLikePasswordDump(t)) {
    return false;
  }
  if (looksLikeFreshErrand(t) && !CORRECTION.test(t)) return false;
  return CORRECTION.test(t) || STREET_LINE.test(t);
}

export function pageWaitsForCode(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
    const identity =
      /^(passport|id|auth|login|account|accounts|oauth|sso|signin|identity)\./.test(
        host,
      ) || host.startsWith("passport.");
    if (identity) {
      return (
        /code|otp|sms|pwl|challenge|verify|auth|add|login/.test(path) ||
        host.startsWith("passport") ||
        host.startsWith("id.")
      );
    }
    return /\/(otp|sms|code|verify|verification|challenge|2fa|mfa|pwl)/.test(
      path,
    );
  } catch {
    return false;
  }
}

export function resultWaitsForCode(
  result: string | undefined | null,
  storedTask?: string | null,
): boolean {
  const hay = [result, storedTask].filter(Boolean).join("\n");
  if (!hay.trim()) return false;
  return OTP_RESULT.test(hay) && /код|otp|sms|смс|push|пуш|passcode|верифиц/i.test(hay);
}

export function isBroCloudTask(task: string | undefined | null): boolean {
  if (!task) return false;
  const t = task.trim();
  return (
    t.startsWith("[bro-errand]") ||
    isLoginWaitTask(t) ||
    isLoginVaultTask(t) ||
    isInjectTask(t)
  );
}

// A V4 Cloud browser is eligible for cleanup after ~20 min without run
// activity (hard cap 4 h). Past that the session cannot be queued into, so
// treat it as no longer live for injection.
const SESSION_LIVE_MS = 20 * 60_000;

export function cloudSessionLooksLive(opts: CloudInjectAttrs): boolean {
  if (!opts.sessionId && !opts.runId) return false;
  if (isActiveCloudStatus(opts.status)) return true;
  if (opts.browserListed) return true;
  if (opts.pageUrl && pageWaitsForCode(opts.pageUrl)) return true;
  const now = opts.now ?? Date.now();
  if (
    opts.sessionId &&
    typeof opts.startedAt === "number" &&
    now - opts.startedAt < SESSION_LIVE_MS
  ) {
    return true;
  }
  return false;
}

function codeRelevantToSession(opts: CloudInjectAttrs): boolean {
  // A live browser is being held for this errand → a code the human just sent
  // is for it. This is the common OTP case (Yandex push, SMS): the tab is on
  // the code screen even when its URL is not a recognizable "code" path.
  if (opts.browserListed) return true;
  if (pageWaitsForCode(opts.pageUrl)) return true;
  if (resultWaitsForCode(opts.result, opts.storedTask)) return true;
  if (
    isLoginWaitTask(opts.storedTask ?? undefined) ||
    isLoginVaultTask(opts.storedTask ?? undefined)
  ) {
    return true;
  }
  if (opts.pageUrl && !pageWaitsForCode(opts.pageUrl)) return false;
  return isBroCloudTask(opts.storedTask);
}

export function decideCloudInject(
  incoming: string,
  opts: CloudInjectAttrs,
): CloudInjectDecision {
  if (looksLikePasswordDump(incoming)) return { kind: null };

  if (isChatCodeMessage(incoming)) {
    const code = extractChatCode(incoming);
    if (!code) return { kind: null };
    const live = cloudSessionLooksLive(opts);
    if (!live) return { kind: "code", code };
    if (!codeRelevantToSession(opts)) return { kind: null };
    return { kind: "code", code };
  }

  if (!cloudSessionLooksLive(opts)) return { kind: null };

  if (isWaitInject(incoming)) {
    if (isActiveCloudStatus(opts.status) || opts.browserListed) {
      return { kind: "wait" };
    }
    return { kind: null };
  }

  if (correctionFitsTask(incoming, opts.storedTask)) {
    return { kind: "correction" };
  }

  // Any other relevant follow-up while a Cloud session is live is a steer:
  // an extra instruction or detail the human wants applied to the open errand.
  if (looksLikeSteer(incoming, opts.storedTask)) {
    return { kind: "steer" };
  }

  return { kind: null };
}

export function injectAckText(kind: CloudInjectKind): string {
  if (kind === "code") return CHAT_CODE_ACK;
  if (kind === "wait") return CHAT_WAIT_ACK;
  return CHAT_INJECT_ACK;
}

export function injectCandidate(text: string): boolean {
  return (
    isChatCodeMessage(text) ||
    isWaitInject(text) ||
    looksLikeCorrectionText(text) ||
    steerCandidate(text)
  );
}

export function cloudInjectAttribute(text: string): Record<string, string> {
  const kind = isChatCodeMessage(text)
    ? "code"
    : isWaitInject(text)
      ? "wait"
      : looksLikeCorrectionText(text)
        ? "correction"
        : null;
  if (!kind) return {};
  // Stamp the raw human line too, so the browser_task tool can inject the exact
  // code/correction the person sent even if the model rephrases the tool call
  // (e.g. re-issues the whole errand instead of passing the bare code).
  return { cloudInject: kind, cloudInjectText: text.trim().slice(0, 240) };
}

/** The exact human line stamped as a cloud inject on this turn, if any. */
export function cloudInjectTextFromAttrs(
  attrs: Record<string, unknown> | undefined,
): string | undefined {
  if (!attrs || attrs.origin !== "human") return undefined;
  const raw = attrs.cloudInjectText;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function cloudInjectKindFromAttrs(
  attrs: Record<string, unknown> | undefined,
): CloudInjectKind | null {
  if (!attrs || attrs.origin !== "human") return null;
  const kind = attrs.cloudInject;
  if (kind === "code" || kind === "wait" || kind === "correction") return kind;
  return null;
}

export function cloudInjectInstruction(
  kind: CloudInjectKind,
  live: boolean,
): string | null {
  if (!live) {
    if (kind === "code") {
      return "The latest human line looks like a one-time code, but there is no live Cloud browser session waiting. Do not start a new search. Say in fluent Russian that there is no open session that needs this code. Never ask for a site password.";
    }
    return null;
  }
  if (kind === "code") {
    return "The latest human line is a one-time code for the live Cloud login/errand. First bubble exactly «ввожу код», then call browser_task with that exact line. Do not substitute the old errand text. Do not ask for a site password. Do not quote the digits.";
  }
  if (kind === "wait") {
    return "The latest human line asks the live Cloud job to wait. First bubble «подожду», then call browser_task with that exact line. Do not start a new search. Never ask for a site password.";
  }
  return "The latest human line may be an address/size/ПВЗ correction for the open Cloud errand. If it is, first bubble «ввожу», then call browser_task with that exact line. If it is unrelated chat, reply normally and do not inject. Never ask for a site password.";
}

function stripMarks(task: string): string {
  return task
    .replace(/^\[bro-(?:errand|login|vault-login|inject)\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/**
 * Concise message queued into a live Cloud session (POST /sessions/{id}/queue).
 * The session already holds the errand context and the open tab, so this is a
 * short follow-up, not the full errand scaffold. Never quotes a site password.
 */
export function injectQueueText(opts: {
  kind: CloudInjectKind;
  humanText: string;
  code?: string;
  dryRun?: boolean;
  alreadyTyped?: boolean;
}): string {
  const human = opts.humanText.trim().slice(0, 300);
  const noOrder = opts.dryRun
    ? " После этого остановись: ничего не заказывай и не оплачивай."
    : "";
  if (opts.kind === "code") {
    if (opts.alreadyTyped) {
      return `Код уже введён в поле на текущей странице. Подтверди вход, если ещё не подтверждён, и продолжи поручение на уже открытой странице. Не открывай новый сайт и не уходи на about:blank. Сайтовый пароль не проси.${noOrder}`;
    }
    const code = (opts.code ?? human).trim();
    return `Одноразовый код для входа (не пароль сайта, не цитируй): ${code}. Введи его в поле кода на уже открытой странице и подтверди вход. Не открывай новый сайт и не уходи на about:blank. Сайтовый пароль не проси и не выдумывай.${noOrder}`;
  }
  if (opts.kind === "wait") {
    return `Человек просит подождать: «${human}». Оставайся на текущем экране, ничего не подтверждай — не нажимай «Заказать», «Поехали» или «Оплатить».`;
  }
  return `Уточнение от человека (не пароль сайта): «${human}». Примени его на уже открытой странице, не открывая новый сайт. Сайтовый пароль не проси.${noOrder}`;
}

/**
 * `interrupt:true` cancels the active run so the queued message runs at once.
 * A correction or «подожди» must preempt whatever the agent is mid-doing; a
 * code is the input a waiting agent expects next, so it is appended, not forced.
 */
export function injectQueueInterrupt(kind: CloudInjectKind): boolean {
  return kind === "wait" || kind === "correction" || kind === "steer";
}

export function injectFollowTask(opts: {
  kind: CloudInjectKind;
  humanText: string;
  originalTask: string;
  code?: string;
  dryRun?: boolean;
}): string {
  const original = stripMarks(opts.originalTask) || "текущее поручение";
  const human = opts.humanText.trim().slice(0, 400);
  const codeLine =
    opts.kind === "code" && opts.code
      ? `Одноразовый код (не пароль, не цитируй): ${opts.code}.`
      : "";
  const waitOrDry = opts.kind === "wait" || opts.dryRun === true;
  const finish = waitOrDry
    ? "Подожди на этом экране. Не подтверждай заказ и не нажимай «Заказать» или «Поехали»."
    : "После этого продолжи исходное поручение на уже открытой странице.";
  return `${INJECT_MARK}
Человек написал в чат (это не пароль сайта): «${human}».
Исходное поручение: ${original}.
Страница уже открыта. Не уходи на about:blank и не открывай новый сайт.
${codeLine}
Если это код / OTP / SMS / пуш — введи в поле кода и подтверди вход. Не цитируй код.
Если это уточнение (адрес, время, размер, ПВЗ) — примени на текущем экране.
Если просит подождать — ничего не подтверждай.
Сайтовый пароль не проси и не выдумывай.
${finish}`;
}
