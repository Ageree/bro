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

export type CloudInjectKind = "code" | "wait" | "correction";

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

const SESSION_LIVE_MS = 30 * 60_000;

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
    looksLikeCorrectionText(text)
  );
}

export function cloudInjectAttribute(text: string): Record<string, string> {
  if (isChatCodeMessage(text)) return { cloudInject: "code" };
  if (isWaitInject(text)) return { cloudInject: "wait" };
  if (looksLikeCorrectionText(text)) return { cloudInject: "correction" };
  return {};
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
