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
export const CHAT_CONFIRM_ACK = "проверяю";

export const NO_LIVE_RUN_TEXT =
  "Сейчас нет открытой страницы, которая ждёт этот код — она уже закрылась. Скажи, что нужно сделать, и я зайду заново.";

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

// Push/bank-app/3DS confirmation from the human's own phone or a live-view
// tab — head-anchored like WAIT_HEAD, with an optional short tail («подтвердил
// вход», «готово, оплатил»). A trailing "?" or a fresh-errand shape (F3) is
// never a confirmation, and the whole line must stay short — a random
// sentence that happens to start with «готово» («готово к выходу?») must not
// match.
const CONFIRM_HEAD =
  /^(подтвердил(?:а)?|подтверждаю|одобрил(?:а)?|готово|сделал(?:а)?|вошел|вошла|зашел|зашла|оплатил(?:а)?|approved|done|confirmed|ок,?\s*подтвердил(?:а)?)(?=$|[\s.!?…,])/;

const CORRECTION =
  /адрес|улиц|проспект|переул|набережн|шоссе|метро|аэропорт|вокзал|домой|на работу|офис|подъезд|квартир|кв\.?|корп|домофон|пвз|пункт выдач|размер|цвет|не туда|не этот|не те|другой адрес|другой пвз|исправ|поправ|откуда|куда|через \d|в \d{1,2}:\d{2}/i;

const STREET_LINE = /[A-Za-zА-Яа-яё]{3,}\s+\d{1,3}[а-яa-z]?/i;

const CODE_WRAPPER = /^(?:код|воткод|смс|sms|otp|push|пуш)$/i;

const OTP_RESULT =
  /needs user input:|код из|смс[- ]?код|sms|one[-\s]?time|passcode|пуш|push (?:code|approval)|verification code|live-url|live url|liveUrl/i;

export type CloudInjectKind = "code" | "wait" | "correction" | "confirm";

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
  /** `tenant.browserNeed` — what the parked Cloud agent is waiting on. */
  need?: string;
  /** true once `findBrowserForSession` was actually called and returned (not
   * just "not set") — lets a confirmed-absent browser outrank the elapsed-time
   * fallback below. */
  browserProbed?: boolean;
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

const CODE_KEYWORD = /код|code|otp|sms|смс|пуш|push/i;
const CODE_ADJACENT_REJECT = /заказ|order|№|руб|₽|р\./i;

// A keyword/reject word only counts within a clause: a comma bounds the
// window so «код 482913, заказ 55081234» doesn't let «заказ» disqualify the
// first number, or «код» rescue the second.
function clauseWindow(s: string, idx: number, before: boolean): string {
  const RANGE = 12;
  if (before) {
    const seg = s.slice(Math.max(0, idx - RANGE), idx);
    const parts = seg.split(/[,;]/);
    return parts[parts.length - 1] ?? "";
  }
  const seg = s.slice(idx, Math.min(s.length, idx + RANGE));
  return seg.split(/[,;]/)[0] ?? "";
}

export function extractChatCode(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 80) return null;

  // Fast path: the whole message is a code with only separators around/inside
  // it («482-913», «48 29 13», «482.913») — no keyword needed, and no letters
  // may survive the strip (a price like «1500 руб» must fall through instead).
  const compact = t.replace(/[\s\-–—.]/g, "");
  if (/^\d{4,8}$/.test(compact) && !YEAR.test(compact)) {
    return compact;
  }

  let normalized = t;
  normalized = normalized.replace(/\b(\d{3})[\s\-–—.](\d{3})\b/g, "$1$2");
  normalized = normalized.replace(
    /\b(\d{2})[\s\-–—.](\d{2})[\s\-–—.](\d{2})\b/g,
    "$1$2$3",
  );

  const found: { code: string; index: number }[] = [];
  const re = /\b(\d{4,8})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized))) {
    const code = m[1]!;
    if (YEAR.test(code)) continue;
    if (found.some((f) => f.code === code)) continue;
    found.push({ code, index: m.index });
  }
  if (found.length === 0) return null;

  const context = (f: { code: string; index: number }) => {
    const before = clauseWindow(normalized, f.index, true);
    const after = clauseWindow(normalized, f.index + f.code.length, false);
    return {
      keyword: CODE_KEYWORD.test(before) || CODE_KEYWORD.test(after),
      reject: CODE_ADJACENT_REJECT.test(before) || CODE_ADJACENT_REJECT.test(after),
    };
  };

  if (found.length === 1) {
    const only = found[0]!;
    return context(only).reject ? null : only.code;
  }

  // Two-plus digit runs: only a candidate next to a code keyword (and not
  // next to an order/price word) disambiguates; otherwise stay silent rather
  // than guess (F5).
  const withKeyword = found.filter((f) => {
    const ctx = context(f);
    return ctx.keyword && !ctx.reject;
  });
  return withKeyword.length === 1 ? withKeyword[0]!.code : null;
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

export function isConfirmInject(text: string): boolean {
  const t = text
    .trim()
    .normalize("NFC")
    .replace(/ё/gi, "е")
    .toLowerCase();
  if (!t || t.length > 40) return false;
  if (t.includes("?")) return false;
  if (looksLikeFreshErrand(text) || looksLikePasswordDump(text)) return false;
  return CONFIRM_HEAD.test(t);
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
  if (
    isChatCodeMessage(t) ||
    isWaitInject(t) ||
    isConfirmInject(t) ||
    looksLikePasswordDump(t)
  ) {
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

const NEEDS_HUMAN = new Set(["sms_code", "email_code", "push", "3ds", "captcha", "password"]);

function tenantNeedsHuman(need: string | undefined): boolean {
  return typeof need === "string" && NEEDS_HUMAN.has(need);
}

export function cloudSessionLooksLive(opts: CloudInjectAttrs): boolean {
  if (!opts.sessionId && !opts.runId) return false;
  // The tenant is recorded as parked waiting on a human input — the session
  // is live by definition, whatever the run status says (F1/Idea 1).
  if (tenantNeedsHuman(opts.need)) return true;
  if (isActiveCloudStatus(opts.status)) return true;
  if (opts.browserListed) return true;
  if (opts.pageUrl && pageWaitsForCode(opts.pageUrl)) return true;
  // `findBrowserForSession` was actually called and came back empty — that is
  // authoritative, not a reason to fall back to the elapsed-time guess (F1).
  if (opts.browserProbed === true) return false;
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

function codeRelevantToSession(opts: CloudInjectAttrs, incoming: string): boolean {
  // A tenant recorded as waiting for exactly this — a code — is authoritative
  // regardless of what page the CDP probe happens to see this turn (the SMS
  // modal on taxi.yandex.ru is not a passport URL, but the wait is real).
  if (opts.need === "sms_code" || opts.need === "email_code") return true;
  if (pageWaitsForCode(opts.pageUrl)) return true;
  if (resultWaitsForCode(opts.result, opts.storedTask)) return true;
  if (
    isLoginWaitTask(opts.storedTask ?? undefined) ||
    isLoginVaultTask(opts.storedTask ?? undefined)
  ) {
    return true;
  }
  if (opts.pageUrl && !pageWaitsForCode(opts.pageUrl)) return false;
  // Bare digits with no код/otp/sms/пуш keyword: an errand merely existing is
  // not enough (F4) — only a tenant recorded as waiting for a code counts.
  if (!CODE_KEYWORD.test(incoming)) return false;
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
    if (!codeRelevantToSession(opts, incoming)) return { kind: null };
    return { kind: "code", code };
  }

  if (isConfirmInject(incoming)) {
    const live = cloudSessionLooksLive(opts);
    const parkedForConfirm =
      opts.need === "push" ||
      opts.need === "3ds" ||
      opts.need === "captcha" ||
      opts.need === "password";
    if (live || parkedForConfirm) return { kind: "confirm" };
    return { kind: null };
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

  return { kind: null };
}

export function injectAckText(kind: CloudInjectKind): string {
  if (kind === "code") return CHAT_CODE_ACK;
  if (kind === "wait") return CHAT_WAIT_ACK;
  if (kind === "confirm") return CHAT_CONFIRM_ACK;
  return CHAT_INJECT_ACK;
}

export function injectCandidate(text: string): boolean {
  return (
    isChatCodeMessage(text) ||
    isWaitInject(text) ||
    isConfirmInject(text) ||
    looksLikeCorrectionText(text)
  );
}

export function cloudInjectAttribute(text: string): Record<string, string> {
  if (isChatCodeMessage(text)) return { cloudInject: "code" };
  if (isWaitInject(text)) return { cloudInject: "wait" };
  if (isConfirmInject(text)) return { cloudInject: "confirm" };
  if (looksLikeCorrectionText(text)) return { cloudInject: "correction" };
  return {};
}

export function cloudInjectKindFromAttrs(
  attrs: Record<string, unknown> | undefined,
): CloudInjectKind | null {
  if (!attrs || attrs.origin !== "human") return null;
  const kind = attrs.cloudInject;
  if (
    kind === "code" ||
    kind === "wait" ||
    kind === "correction" ||
    kind === "confirm"
  ) {
    return kind;
  }
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
  if (kind === "confirm") {
    return "The latest human line reports that the human confirmed a push/app/3-D-Secure step from their own phone, or finished a step in live-view. First bubble exactly «проверяю», then call browser_task with that exact line — do not retype or re-enter anything, just check whether the screen advanced and continue the errand on the already-open page. Never ask for a site password.";
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
    return `Одноразовый код для входа (не пароль сайта, не цитируй): ${code}. Введи его в поле кода на уже открытой странице и подтверди вход. Если поле кода не видно — сначала нажми «Получить код»/«Войти по SMS» не более одного раза. Не открывай новый сайт и не уходи на about:blank. Сайтовый пароль не проси и не выдумывай.${noOrder}`;
  }
  if (opts.kind === "wait") {
    return `Человек просит подождать: «${human}». Оставайся на текущем экране, ничего не подтверждай — не нажимай «Заказать», «Поехали» или «Оплатить».`;
  }
  if (opts.kind === "confirm") {
    return `Человек подтвердил со своего телефона / завершил шаг в live-view («${human}»). Проверь, продвинулся ли экран, и продолжи поручение на открытой странице. Ничего не вводи повторно.`;
  }
  return `Уточнение от человека (не пароль сайта): «${human}». Примени его на уже открытой странице, не открывая новый сайт. Сайтовый пароль не проси.${noOrder}`;
}

/**
 * `interrupt:true` cancels the active run so the queued message runs at once.
 * A correction or «подожди» must preempt whatever the agent is mid-doing; a
 * code is the input a waiting agent expects next, so it is appended, not forced.
 */
export function injectQueueInterrupt(kind: CloudInjectKind): boolean {
  return kind === "wait" || kind === "correction";
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
