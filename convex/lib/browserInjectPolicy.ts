/**
 * Mid-run iMessage → live Browser Use Cloud session.
 *
 * While a session is live the default is to QUEUE the human's line into it —
 * a code, «подожди», an address correction, a confirmation, or just an extra
 * detail («на воскресенье»). Only the named exclusions stay out: smalltalk,
 * questions aimed at Bro, password dumps, emoji, lone letter+digit tokens and
 * genuinely fresh errands. Unrelated chat stays a normal Bro reply. Site
 * passwords never go in iMessage.
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

export type CloudInjectKind = "code" | "wait" | "correction" | "confirm" | "steer";

// Pure chatter and status questions to Bro must never be docked into a live
// Cloud session. Everything else the human sends while a session is live is
// treated as a relevant steer (extra instruction / detail for the errand).
// A lone «норм»/«давай»/«пойдёт» is the same kind of noise as «ок» — it has
// to sit here, because steering is now opt-OUT and anything not named here
// gets queued into the live session.
const SMALLTALK =
  /^(привет\w*|здоров\w*|хай|ку|hi|hello|hey|спасибо( большое)?|спс|благодар\w*|пасиб\w*|ок\w*|okay?|ok|да|нет|неа|ага|угу|понял\w*|ясно|хорошо|ладно|класс|супер|отлично|круто|збс|топ|норм|нормально|пойдет|годится|давай|давайте|thanks|thx|ty|лол)\s*[.!?…]*$/iu;

// Status / wellbeing questions aimed at Bro, typed without a question mark.
// A trailing «?» already excludes the punctuated ones; «как дела» and «ну что
// там» are the same thing and must not be queued into the errand either.
// Head-anchored and short, so «что там с бронью на воскресенье» (a real
// follow-up, 6 words) is not swallowed by it.
const CHATTER_Q =
  /^(как дела|как ты|как оно|как жизнь|как успехи|что там|ну что|ну как|что нового|что делаешь|чем занят|ты тут|ты там|ты здесь|ты жив[а-я]*|ты где)(?=$|[\s.!?…,])/i;

// Only a message that is ~all emoji / punctuation, no letters or digits.
const EMOJI_ONLY = /^[^\p{L}\p{N}]+$/u;

/**
 * A message worth docking into a live Cloud session as a steer, sans session
 * context.
 *
 * Steering is OPT-OUT, not opt-in. The old gate required an explicit
 * imperative cue (a `STEER_SIGNAL` regex of verbs: «сделай», «поменяй»…), and
 * that is exactly what lost the real report: the human asked to book a
 * restaurant, the Cloud session started, and a second later they wrote «на
 * воскресенье». No verb → no cue → the detail was dropped on the floor and
 * the table was booked for the wrong day. The same holds for «на 4 человек»,
 * «на 19:00», «в центре», «у окна» — the whole vocabulary of follow-up
 * parameters is verbless.
 *
 * So while a session is live the default is QUEUE IT, and only the shapes we
 * can name are excluded: smalltalk, a question aimed at Bro, a password dump,
 * an emoji reaction, a lone letter+digit token, a genuinely fresh errand —
 * plus code/wait/confirm/correction, which are their own earlier-winning
 * kinds. A queued line costs one message inside the session; a dropped line
 * costs the errand.
 */
export function steerCandidate(text: string): boolean {
  const t = text.trim().normalize("NFC").replace(/ё/gi, "е");
  // 400-char cap kept: a wall of text is a new brief, not a follow-up detail.
  if (!t || t.length > 400) return false;
  if (looksLikePasswordDump(t)) return false;
  if (EMOJI_ONLY.test(t)) return false;
  if (/[?？]\s*$/.test(t)) return false; // a question to Bro is not a steer
  if (SMALLTALK.test(t)) return false;
  if (t.split(/\s+/).length <= 4 && CHATTER_Q.test(t)) return false;
  // Codes / «подожди» / confirmations / corrections are their own kinds.
  if (
    isChatCodeMessage(t) ||
    isWaitInject(t) ||
    isConfirmInject(t) ||
    looksLikeCorrectionText(t)
  ) {
    return false;
  }
  // A brand-new, unrelated errand opens a fresh session, it is not a steer.
  if (looksLikeFreshErrand(t)) return false;
  // A lone space-free letter+digit token (login / tracking id / secret): skip.
  if (!/\s/.test(t) && /[A-Za-zА-Яа-яе]/.test(t) && /\d/.test(t)) return false;
  return true;
}

/** Steer fires while a Cloud errand session with a task is on record — or
 *  while a start for one is in flight, which is the window the «на
 *  воскресенье» follow-up actually lands in (the tenant row has a start claim
 *  but no task/session id yet). */
export function looksLikeSteer(
  text: string,
  storedTask?: string | null,
  opts?: { startInFlight?: boolean },
): boolean {
  if (!steerCandidate(text)) return false;
  return Boolean(storedTask && storedTask.trim()) || opts?.startInFlight === true;
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
  /** `tenant.browserNeed` — what the parked Cloud agent is waiting on. */
  need?: string;
  /** true once `findBrowserForSession` was actually called and returned (not
   * just "not set") — lets a confirmed-absent browser outrank the elapsed-time
   * fallback below. */
  browserProbed?: boolean;
  /** `tenant.browserStartingAt` — a start claimed on the tenant row *before*
   * `startRun` round-trips. Between the claim and the first `persist()` there
   * is no runId and no sessionId at all, which is the ~10s window the «на
   * воскресенье» follow-up landed in and got treated as a brand-new errand. */
  startingAt?: number | null;
};

/** How long a start claim on the tenant row is believed. A Cloud start
 * round-trips in seconds; past this the claiming turn is assumed dead (the
 * process was killed mid-start) and a new start may proceed, so a crashed
 * start can never wedge the tenant into "always starting". */
export const START_CLAIM_MS = 2 * 60_000;

/** How long a follow-up parked by `holdBrowserSteer` may still be queued into
 * a session. A held line belongs to the errand that was starting when it was
 * typed; past this it is stale, and queueing it into whatever session exists
 * later would apply «на воскресенье» to an unrelated errand. */
export const PENDING_STEER_TTL_MS = 10 * 60_000;

/** Is a start claim on the tenant row still believed? The Convex mutation
 * that hands out the claim (`tenants.claimBrowserStart`) and every agent-side
 * reader go through this one function, so "who is starting" can never be
 * answered two different ways. `0`/absent means no claim. */
export function startClaimIsLive(
  startingAt: number | null | undefined,
  now: number,
  staleMs: number = START_CLAIM_MS,
): boolean {
  if (typeof startingAt !== "number" || startingAt <= 0) return false;
  return now - startingAt < staleMs;
}

/** True while another turn has claimed a start that has not produced a
 * run/session yet. Callers must treat this exactly like a live session for
 * inject purposes: hold the follow-up, never open a second Cloud run. */
export function cloudStartInFlight(opts: {
  startingAt?: number | null;
  now?: number;
}): boolean {
  return startClaimIsLive(opts.startingAt, opts.now ?? Date.now());
}

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
  // A single space-free token that mixes letters and digits is very likely a
  // secret (password / login / token). We do NOT require a special char —
  // "Hunter2024" / "Password1" must be caught too — but a pure-digit string is
  // an OTP, handled elsewhere, so it is not a dump.
  return /[A-Za-zА-Яа-яёЁ]/.test(t) && /\d/.test(t);
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
  // A cloud errand session is on record whenever a stored task exists. The
  // task is persisted raw (unmarked), so gate on its presence, not a mark —
  // requiring `[bro-errand]` here made corrections/steers inert for real
  // taxi/shop errands.
  if (!looksLikeCorrectionText(text) || !(storedTask && storedTask.trim())) {
    return false;
  }
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
  // Require actual OTP evidence beyond that, not merely a listed browser:
  // otherwise any bare number typed mid-errand (order no., quantity, intercom
  // code) would be force-typed into a login field. The real Yandex push case
  // is covered by pageWaitsForCode (passport./id.) and by resultWaitsForCode
  // ("нужен код") below.
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

  // A start claimed a moment ago but not yet persisted its ids counts as a
  // session for every decision below: the browser is (or is about to be)
  // there, and the caller holds the line until the session id exists.
  const starting = cloudStartInFlight(opts);

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
    if (live || parkedForConfirm || starting) return { kind: "confirm" };
    return { kind: null };
  }

  if (!cloudSessionLooksLive(opts) && !starting) return { kind: null };

  if (isWaitInject(incoming)) {
    if (isActiveCloudStatus(opts.status) || opts.browserListed || starting) {
      return { kind: "wait" };
    }
    return { kind: null };
  }

  if (correctionFitsTask(incoming, opts.storedTask)) {
    return { kind: "correction" };
  }

  // Any other follow-up while a Cloud session is live (or being started) is a
  // steer: an extra instruction or detail the human wants applied to the open
  // errand. Opt-out — see `steerCandidate` for why a verb is never required.
  if (looksLikeSteer(incoming, opts.storedTask, { startInFlight: starting })) {
    return { kind: "steer" };
  }

  return { kind: null };
}

export function injectAckText(kind: CloudInjectKind): string {
  if (kind === "code") return CHAT_CODE_ACK;
  if (kind === "wait") return CHAT_WAIT_ACK;
  if (kind === "confirm") return CHAT_CONFIRM_ACK;
  return CHAT_INJECT_ACK;
}

/**
 * Text-only "could this ever be an inject?" predicate. It knows nothing about
 * liveness, so it must never be used as a pre-filter *before* the session
 * state is known — that ordering is precisely what let `browser_task` drop
 * «на воскресенье» before it ever looked at whether a Cloud session was live
 * (`maybeInjectChat` now checks liveness first and calls `decideCloudInject`,
 * which is the one authority). Kept for the channel-side stamp and tests.
 */
export function injectCandidate(text: string): boolean {
  return (
    isChatCodeMessage(text) ||
    isWaitInject(text) ||
    isConfirmInject(text) ||
    looksLikeCorrectionText(text) ||
    steerCandidate(text)
  );
}

export function cloudInjectAttribute(text: string): Record<string, string> {
  const kind = isChatCodeMessage(text)
    ? "code"
    : isConfirmInject(text)
      ? "confirm"
      : isWaitInject(text)
        ? "wait"
        : looksLikeCorrectionText(text)
          ? "correction"
          : steerCandidate(text)
            ? "steer"
            : null;
  if (!kind) return {};
  // Stamp the raw human line too, so the browser_task tool can inject the exact
  // code/correction/confirmation the person sent even if the model rephrases
  // the tool call (e.g. re-issues the whole errand instead of passing the
  // bare code).
  //
  // `steer` IS stamped now. It used to be left out because this stamp is
  // text-only and cannot know whether a session is live — but the cost of
  // that purity was that a steer got no «ввожу» bubble and no system
  // instruction, so «на воскресенье» reached the model as ordinary chat and
  // usually never became a browser_task call at all. Liveness is still
  // decided later, where it is known: `cloudInjectInstruction(kind, live)`
  // returns null for a steer with no live session, and `maybeInjectChat`
  // checks liveness itself before queueing anything.
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
  if (
    kind === "code" ||
    kind === "wait" ||
    kind === "correction" ||
    kind === "confirm" ||
    kind === "steer"
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
      return "The latest human line looks like a one-time code, but no live Cloud session is waiting for one. Do not start a search. Say in fluent Russian that nothing open needs this code. Never ask for a site password.";
    }
    return null;
  }
  if (kind === "code") {
    return "The latest human line is a one-time code for the live Cloud errand. First bubble exactly «ввожу код», then call browser_task with that exact line — not the old errand text. Do not quote the digits. Never ask for a site password.";
  }
  if (kind === "wait") {
    return "The latest human line asks the live Cloud job to hold. First bubble exactly «подожду», then call browser_task with that exact line. Do not start a search. Never ask for a site password.";
  }
  if (kind === "steer") {
    return "The latest human line is an extra detail for the live Cloud errand — a day, a time, a party size, a place, a preference. It usually carries no verb at all («на воскресенье», «на 4 человек», «у окна»). First bubble exactly «ввожу», then call browser_task with that exact line so it is queued into the open session. Do not start a new search and do not re-send the old errand text. Never ask for a site password.";
  }
  if (kind === "confirm") {
    return "The latest human line says the human approved a push / app / 3-D Secure step on their own phone, or finished a step in live-view. First bubble exactly «проверяю», then call browser_task with that exact line: the agent only checks whether the screen advanced and carries on with the open page, it re-enters nothing. Never ask for a site password.";
  }
  return "The latest human line may be a correction to the open Cloud errand (address, size, pickup point, any other detail). If it is, first bubble exactly «ввожу», then call browser_task with that exact line. If it is unrelated chat, reply normally and do not inject. Never ask for a site password.";
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
      return `Код уже введён в поле на этой странице. Подтверди вход и продолжай поручение здесь же, новый сайт не открывай.${noOrder}`;
    }
    const code = (opts.code ?? human).trim();
    return `Одноразовый код для входа (это не пароль сайта, не цитируй его): ${code}. Введи его в поле кода на этой странице и подтверди вход. Поля кода не видно — один раз нажми «Получить код» или «Войти по SMS». Новый сайт не открывай. Сайтовый пароль не проси и не выдумывай.${noOrder}`;
  }
  if (opts.kind === "wait") {
    return `Человек просит подождать: «${human}». Оставайся на текущем экране и ничего не подтверждай — не жми «Заказать», «Поехали», «Оплатить».`;
  }
  if (opts.kind === "confirm") {
    return `Человек подтвердил со своего телефона или закончил шаг в live-view («${human}»). Проверь, продвинулся ли экран, и продолжай поручение здесь же. Ничего не вводи повторно.`;
  }
  // steer reuses the correction template with "Дополнение" instead of
  // "Инструкция" — it is an extra instruction/detail for the open errand
  // rather than a location/size-style fix — but keeps #101's safety sentence.
  const head = opts.kind === "steer" ? "Дополнение" : "Инструкция";
  return `${head} от человека: «${human}». Примени ${opts.kind === "steer" ? "его" : "её"} на этой странице, новый сайт не открывай. Пароли, карты и коды из этого текста не вводи.${noOrder}`;
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
  const head = `${INJECT_MARK}
Человек написал в чат (это не пароль сайта): «${human}».
Поручение: ${original}.
Страница уже открыта — продолжай прямо с неё, новый сайт не открывай.`;
  const hold =
    "Стой на этом экране. Не подтверждай заказ и не жми «Заказать» или «Поехали».";
  if (opts.kind === "wait") {
    return `${head}\nЧеловек просит подождать. ${hold}`;
  }
  const tail = opts.dryRun === true ? hold : "Дальше продолжи поручение здесь же.";
  if (opts.kind === "code") {
    const codeLine = opts.code ? ` Код: ${opts.code}.` : "";
    return `${head}
Это одноразовый код, не пароль.${codeLine} Введи его в поле кода и подтверди вход, сам код не цитируй.
${tail}`;
  }
  return `${head}
Это уточнение к поручению — адрес, время, размер, ПВЗ или другая деталь. Примени его на текущем экране. Пароли, карты и коды из этого текста не вводи.
${tail}`;
}
