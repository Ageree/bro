import { createHash } from "node:crypto";
import {
  isBrowserProfileId,
  LOGIN_MARK,
  LOGIN_VAULT_MARK,
  loginWaitTask,
  normalizeBrowserProfileId,
  pickCookieDomains,
} from "../../convex/lib/browserProfilePolicy.ts";
import { INJECT_MARK } from "../../convex/lib/browserInjectPolicy.ts";
import { DONE } from "../../convex/lib/browserFollowPolicy.ts";
import {
  liveUrlFromRunPayloads,
  loginHostsMatch,
  loginLandingReady,
  pageUrlFromEvents,
  runEventsPath,
} from "../../convex/lib/browserLivePolicy.ts";
import {
  browserFromList,
  cdpPageUrl,
  type CloudBrowser,
} from "../../convex/lib/browserCdp.ts";
import { scrubSecrets } from "../../convex/lib/secretScrub.ts";
import { cdpNavigate } from "./browser-cdp.ts";
import {
  isAttachCardErrand,
  loginScaffold,
  payScaffold,
  type SecretBinding,
} from "./browser-pay.ts";
import {
  composeErrandBrief,
  knownFactsBlock,
  MISSING_FACTS_LINE,
  staticBriefLine,
  type ErrandFacts,
} from "./errand-brief.ts";
import { loadErrandFacts } from "./errand-context.ts";

const DEFAULT_BASE = "https://api.browser-use.com/api/v4";

/**
 * Browser Use v4, or a stand-in.
 *
 * `BROWSER_USE_BASE_URL` exists so a staging deployment can point at
 * `scripts/fake-browser-use.ts` and run shopping and login errands end to end
 * without spending money or waiting on a real site. It is a base URL rather
 * than a "pretend" flag on purpose: a flag that leaked into production would
 * silently make Bro act as if it had bought things, while a wrong base URL is
 * a visible, deliberate act that shows up in `convex env list` and in every
 * log line. Unset, nothing changes.
 */
function base(): string {
  return process.env.BROWSER_USE_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_BASE;
}

/** Browser Use Cloud recommended V4 model. Flash kept dying mid-answer. */
export const DEFAULT_BROWSER_MODEL = "gpt-5.6-luna";

export {
  isBrowserProfileId,
  loginWaitTask,
  normalizeBrowserProfileId,
};

/** Cloud `model` for POST /runs. Empty BRO_BROWSER_MODEL keeps the default. */
export function resolveBrowserModel(
  raw: string | undefined = process.env.BRO_BROWSER_MODEL,
): string {
  const model = raw?.trim();
  return model ? model : DEFAULT_BROWSER_MODEL;
}

/** ISO 3166-1 alpha-2 from BROWSERUSE_PROXY_COUNTRY. Unset → undefined (API default US). */
export function proxyCountryCode(
  raw: string | undefined = process.env.BROWSERUSE_PROXY_COUNTRY,
): string | undefined {
  const c = raw?.trim().toLowerCase();
  if (!c) return undefined;
  return /^[a-z]{2}$/.test(c) ? c : undefined;
}

/**
 * Browser Use API v4 create-run proxy country.
 * https://docs.browser-use.com/cloud/browser/proxies
 * Field: browserSettings.proxyCountryCode (REST/SDK camelCase).
 */
export function applyProxyCountry(
  body: Record<string, unknown>,
  country: string | undefined = proxyCountryCode(),
): Record<string, unknown> {
  if (!country) return body;
  return {
    ...body,
    browserSettings: { proxyCountryCode: country },
  };
}

/**
 * Every whitespace character is stripped, not just the ends.
 *
 * This bit us for real: the secret arrived from the store with a newline in
 * the MIDDLE of the value, and `fetch` rejects such a header outright
 * (`Headers.append: "…" is an invalid header value`), so the request never
 * left the process. Every errand failed, and the error pointed at headers
 * rather than at the malformed secret — slow to diagnose, because nothing in
 * it says "your key is wrapped". `.trim()` would not have helped: it only
 * touches the ends. A Browser Use key carries no internal whitespace of its
 * own, so stripping can only rescue a wrapped key, never corrupt a valid one.
 * Same treatment the fast-ack, phrasing and errand-brief lanes give
 * `OPENROUTER_API_KEY`.
 */
export function normalizeBrowserUseKey(raw: string | undefined): string | undefined {
  return raw?.replace(/\s+/gu, "") || undefined;
}

/** Once per process: the code works around the malformed secret, but the
 *  stored value is still wrong and only a human can fix that. */
let warnedWrappedKey = false;

function key(): string {
  const raw = process.env.BROWSER_USE_API_KEY;
  const k = normalizeBrowserUseKey(raw);
  if (raw !== undefined && raw !== k && !warnedWrappedKey) {
    warnedWrappedKey = true;
    // Never the value itself — just that it is wrapped, and where to look.
    console.warn(
      "BROWSER_USE_API_KEY contains whitespace (a newline mid-value survives a paste into a hosted env); stripping it for the request, but re-set the stored secret",
    );
  }
  if (!k) throw new Error("BROWSER_USE_API_KEY missing");
  return k;
}

async function bu(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      "X-Browser-Use-API-Key": key(),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new Error(`browser-use ${res.status} ${path}: ${text.slice(0, 400)}`);
  }
  return body;
}

function pick(obj: Record<string, unknown>, names: string[]): string | undefined {
  for (const n of names) {
    const v = obj[n];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export type BrowserRun = {
  runId: string;
  sessionId?: string;
  status: string;
  liveUrl?: string;
  result?: string;
  pageUrl?: string;
  landed?: boolean;
};

const ERRAND_MARK = "[bro-errand]";

/**
 * Only an explicit dry-run skips «Заказать».
 * A real «вызови такси» must finish the order after login.
 */
export function isDryRunErrand(task: string): boolean {
  const t = task.toLowerCase();
  return (
    /не\s+нажимай(?:те)?\s+[«"']?заказать/.test(t) ||
    /не\s+нажимать\s+[«"']?заказать/.test(t) ||
    /не\s+заказывай/.test(t) ||
    /\bбез\s+заказа\b/.test(t) ||
    /dry[- ]?run/.test(t) ||
    /не\s+создавай\s+(?:реальн\w*\s+)?(?:поездк|заказ)/.test(t)
  );
}

/**
 * The credential half of the envelope. What used to live here as well —
 * «В профиле могут быть куки прошлой сессии…» — is gone on purpose: it was
 * 98 characters of advice on every run telling a browser agent to look at
 * the screen, which is the one thing a browser agent does unprompted.
 *
 * The fact-abort sentence that used to close this block is gone too, and
 * that one was a bug, not just noise. It told the run to stop on any fact
 * only the human could know, while Bro held those facts in the vault and
 * never passed them. The facts now arrive in `knownFactsBlock()` above and
 * `KNOWN_FACTS_GAP` / `MISSING_FACTS_LINE` keep `НУЖНО: address|info` as the
 * fallback for what is genuinely missing.
 */
function errandLoginBlock(opts?: { login?: boolean }): string {
  const lines: string[] = [];
  if (opts?.login) lines.push(loginScaffold());
  // The licence to sign in or register WITHOUT asking is load-bearing, not
  // prose. It was the entire substance of «Cloud errand must log in when the
  // site shows Войти» (#94): a run that treats «Войти» as a wall stops on a
  // guest screen and reports nothing done. The surrounding advice around it
  // really was stale and stayed deleted; this one sentence comes back, short.
  lines.push(
    "«Войти» или гостевая форма — входи или регистрируйся сам (паспорт, Яндекс ID — норма).",
  );
  lines.push(
    opts?.login
      ? "Упёрся в код, пуш или капчу — закончи с НУЖНО: sms_code, email_code, push или captcha."
      : "Логин и пароль из задачи вводи сам; выдумывать пароль или номер карты нельзя. Упёрся в код, пуш, капчу или чужой пароль — закончи с НУЖНО: sms_code, email_code, push, captcha или password.",
  );
  return lines.join("\n");
}

/**
 * How this run ends. The default line used to carry a worked taxi example
 * («у такси заполни откуда/куда…») inside a sentence that applies to every
 * errand — a hardcoded example of one errand shipped with all the others.
 * The brief above now says what "done" looks like for THIS errand, so this
 * only has to say that there IS a final button and that it is pressed once.
 */
function errandFinishBlock(
  task: string,
  payBlock: string | undefined,
  attachCard?: boolean,
): string {
  if (attachCard) {
    return "Ничего не заказывай и не вызывай. Код от банка подтверди.";
  }
  if (payBlock) {
    return "Доводи дело до конца, включая оплату картой. Дважды не заказывай и не плати.";
  }
  if (isDryRunErrand(task)) {
    return "Это проверка без заказа: дойди до формы, покажи цену. Не нажимай «Заказать» или «Поехали».";
  }
  return "Доводи дело до конца и жми финальную кнопку подтверждения. Дважды не заказывай.";
}

export type ProfileView = {
  id: string;
  cookieDomains: string[];
};

/**
 * Chrome cookies already on the Cloud profile. Type a password only if the task includes one.
 * `BROWSER_USE_PROFILE_ID` is only shared across runs when `BROWSER_USE_PROFILE_PHONE`
 * names the one tenant it belongs to — otherwise every tenant gets their own profile.
 */
export function envSyncedProfileId(
  phone: string,
  raw: string | undefined = process.env.BROWSER_USE_PROFILE_ID,
  ownerPhone: string | undefined = process.env.BROWSER_USE_PROFILE_PHONE,
): string | undefined {
  if (!ownerPhone || ownerPhone.trim() !== phone.trim()) return undefined;
  return normalizeBrowserProfileId(raw);
}

/** True when `task` already carries one of the marks the scaffold owns. */
export function isScaffolded(task: string): boolean {
  return (
    task.startsWith(ERRAND_MARK) ||
    task.startsWith(LOGIN_MARK) ||
    task.startsWith(LOGIN_VAULT_MARK) ||
    task.startsWith(INJECT_MARK)
  );
}

/**
 * The goal, in the human's terms. `brief` is what the per-errand composer
 * wrote (what "done" looks like for THIS errand); with the composer off, the
 * static `ЦЕЛЬ: <task>` line the scaffold always opened with.
 *
 * `ДОСЛОВНО` is the fix for the finding that the human's literal sentence
 * never reached a run at all: `task` is whatever the coordinator model
 * retyped into the tool argument, so when the caller can hand over the real
 * wording it rides along verbatim, and when it cannot, the raw `task` does.
 */
function errandGoalBlock(
  task: string,
  opts?: { brief?: string; humanText?: string },
): string {
  const brief = opts?.brief?.trim();
  const trimmed = task.trim();
  // `scrubSecrets` here and not only on the brief: this is the one line that
  // carries the human's raw keystrokes to a third-party browser vendor, and a
  // person who types «мой пароль: qwerty123» mid-errand must not have it
  // shipped out verbatim and logged on someone else's infrastructure. The
  // task as a whole is still deliberately unscrubbed — a 13-digit tracking
  // number is indistinguishable from a PAN to the regex, and blanking it
  // would delete the errand's own subject.
  const verbatim = scrubSecrets(opts?.humanText?.trim() || trimmed).trim();
  const lines = [`ЦЕЛЬ: ${brief || staticBriefLine(task)}`];
  // Never restate the goal as its own quote. Without an OPENROUTER key there
  // is no brief, `!brief` is always true, and `verbatim` defaults to `task` —
  // so every keyless deployment printed ЦЕЛЬ and ДОСЛОВНО with identical
  // text. A commit whose thesis is "delete boilerplate" must not add a line.
  if (verbatim && verbatim !== trimmed && (!brief || !brief.includes(verbatim))) {
    lines.push(`ДОСЛОВНО ОТ ЧЕЛОВЕКА: «${verbatim}»`);
  }
  return lines.join("\n");
}

/**
 * Wrap a raw errand with the cloud-browser operating envelope. Idempotent if
 * already marked.
 *
 * The envelope is deliberately thin now. What a 1,497-character task used to
 * spend on «решай сам», «работай быстро», «важен результат» and a cookie
 * note is gone — that was ~980 characters of generic browsing advice on
 * every run, and a capable browser agent needs none of it. What is left is
 * either parsed by our own code (the mark, the output contract, the
 * `secretBindings` alias names) or is a fact about THIS errand: the brief,
 * the human's own words, and the facts Bro already knows about them.
 */
export function scaffoldTask(
  task: string,
  opts?: {
    /** Cookies from a previous session are already on the Cloud profile.
     *  No longer changes a single character of the task — the note it used
     *  to add was advice, not information — but every call site still passes
     *  it, and it stays part of the contract for whatever needs it next. */
    profileSynced?: boolean;
    pay?: Parameters<typeof payScaffold>[0];
    login?: boolean;
    startPage?: string;
    /** This run continues a PREVIOUS step of the same errand in the same
     *  Cloud session — the page is already open and mid-flow. Never true
     *  together with `startPage` (there is no fresh navigation to do). */
    continuation?: boolean;
    /** The per-errand brief from `composeErrandBrief`. Absent → the static
     *  `ЦЕЛЬ: <task>` line, i.e. exactly what shipped before this existed. */
    brief?: string;
    /** The human's original wording, when the caller has it. */
    humanText?: string;
    /** Non-secret facts Bro already holds — see `agent/lib/errand-context.ts`. */
    facts?: ErrandFacts;
  },
): string {
  if (isScaffolded(task)) return task;
  const attachCard = opts?.pay?.attachCard ?? isAttachCardErrand(task);
  const payBlock = opts?.pay
    ? payScaffold({ ...opts.pay, ...(attachCard ? { attachCard: true } : {}) })
    : undefined;
  const stopForPay = attachCard
    ? "Карта к запуску не подключена — дойди до формы карты и закончи с НУЖНО: payment."
    : "Дошло до оплаты — закончи с НУЖНО: payment.";
  const login = errandLoginBlock({ login: opts?.login });
  const finish = errandFinishBlock(task, payBlock, attachCard);
  const goal = errandGoalBlock(task, {
    ...(opts?.brief ? { brief: opts.brief } : {}),
    ...(opts?.humanText ? { humanText: opts.humanText } : {}),
  });
  // Facts first, `НУЖНО` second. The old scaffold had only the second half,
  // so a run aborted asking for a street that was in the vault all along.
  const facts = knownFactsBlock(opts?.facts) || MISSING_FACTS_LINE;
  // A continuation must never re-navigate or redo what the previous step of
  // THIS SAME errand already did (the taxi incident: a fresh run re-drove
  // the whole route because eve tore down the old browser first) — the tab
  // is already open exactly where the last step left it.
  const alreadyOpen = opts?.continuation
    ? "Страница уже открыта с предыдущего шага этого же поручения — продолжай прямо с неё, заново ничего не открывай и не вводи."
    : opts?.startPage
      ? `Страница уже открыта: ${opts.startPage} — работай на ней, на языке сайта.`
      : "Сайт откроет Bro сам — дождись страницы и работай на ней, на языке сайта.";
  return `${ERRAND_MARK}
${goal}
${facts}
${alreadyOpen}
Решай сам и человека не спрашивай.
${login}
${payBlock ?? stopForPay}
${finish}

Итог — только в этом формате, каждое поле с новой строки:
СДЕЛАНО: <одна фраза>
ЗАКАЗ: <номер или нет>
СУММА: <число ₽ или нет>
КОГДА: <дата/время/ETA или нет>
ВАРИАНТЫ: <до 5 «название — цена — ссылка», через ; или нет>
НУЖНО: none|sms_code|email_code|push|3ds|captcha|password|address|payment|info
ДЕТАЛИ: <что именно нужно от человека, одной строкой, или нет>
Никогда не пиши в итог пароль, номер карты или код.`;
}

/** Stable, non-reversible profile name/id — never the raw phone number. */
export function hashedProfileName(phone: string): string {
  const digest = createHash("sha256")
    .update(`browseruse-profile\0${phone}`)
    .digest("hex");
  return `bro-${digest.slice(0, 40)}`;
}

export async function createProfile(phone: string): Promise<string> {
  const name = hashedProfileName(phone);
  const created = await bu("/profiles", {
    method: "POST",
    body: JSON.stringify({ userId: name, name }),
  });
  const id = pick(created, ["id"]);
  if (!id) throw new Error(`browser-use profile: no id in ${JSON.stringify(created).slice(0, 400)}`);
  return id;
}

function asProfile(body: Record<string, unknown>): ProfileView {
  const id = pick(body, ["id"]);
  if (!id || !isBrowserProfileId(id)) {
    throw new Error(`browser-use profile: no id in ${JSON.stringify(body).slice(0, 400)}`);
  }
  return { id, cookieDomains: pickCookieDomains(body.cookieDomains ?? body.cookie_domains) };
}

export async function getProfile(profileId: string): Promise<ProfileView> {
  const id = normalizeBrowserProfileId(profileId);
  if (!id) throw new Error("browser-use profile: invalid id");
  return asProfile(await bu(`/profiles/${id}`));
}

function resolveProxyCountry(): string | undefined {
  const explicit = proxyCountryCode(process.env.BROWSERUSE_PROXY_COUNTRY);
  if (explicit) return explicit;
  const fallback = process.env.BRO_BROWSER_PROXY ?? "ru";
  if (fallback.trim().toLowerCase() === "none") return undefined;
  return proxyCountryCode(fallback);
}

export type StartRunOpts = {
  profileId?: string;
  profileSynced?: boolean;
  pay?: Parameters<typeof payScaffold>[0];
  login?: boolean;
  secretBindings?: SecretBinding[];
  startPage?: string;
  /** Resume the same errand in `sessionId`'s already-open tab — see
   *  `scaffoldTask`. Never combined with `startPage`. */
  continuation?: boolean;
  /** Tenant phone. Present → this run carries the human's own non-secret
   *  facts (vault address/contact, curated memories, their timezone and
   *  today's date in it, their display name). Absent → nothing is looked up
   *  and the task is the static scaffold, exactly as before. */
  phone?: string;
  /** The human's ORIGINAL wording. `task` is whatever the coordinator model
   *  retyped; this is what they actually said, and it rides along verbatim. */
  humanText?: string;
  /** Pre-loaded facts, for a caller that already has them (and for tests).
   *  Wins over `phone`, which is only the instruction to go and load them. */
  facts?: ErrandFacts;
};

/**
 * The context + brief for one run. Everything in here is best-effort: a
 * Convex hiccup, a missing key or a slow model costs the run some context,
 * never the run. `isScaffolded` short-circuits the whole thing for login /
 * vault-login / inject tasks, which `scaffoldTask` returns untouched anyway.
 */
async function errandBriefing(
  task: string,
  opts: StartRunOpts | undefined,
): Promise<{ brief?: string; facts?: ErrandFacts }> {
  if (isScaffolded(task)) return {};
  const facts =
    opts?.facts ??
    (opts?.phone
      ? await loadErrandFacts(opts.phone).catch((err: unknown) => {
          console.error("errand context failed", err);
          return undefined;
        })
      : undefined);
  // `composeErrandBrief` documents itself as never throwing, and it is written
  // that way — but it is awaited before the run body is built, so if that
  // contract ever breaks the cost is not a missing brief, it is every browser
  // errand failing. Cheap belt to go with the braces.
  const brief = await composeErrandBrief({
    task,
    ...(opts?.humanText ? { humanText: opts.humanText } : {}),
    ...(facts ? { facts } : {}),
    ...(opts?.pay ? { pay: true } : {}),
    ...(opts?.login ? { login: true } : {}),
    ...(opts?.continuation ? { continuation: true } : {}),
    ...(opts?.startPage ? { startPage: opts.startPage } : {}),
  }).catch((err: unknown) => {
    console.error("errand brief threw", err);
    return null;
  });
  return {
    ...(brief ? { brief } : {}),
    ...(facts ? { facts } : {}),
  };
}

export async function startRun(
  task: string,
  sessionId?: string,
  opts?: StartRunOpts,
): Promise<BrowserRun> {
  const briefing = await errandBriefing(task, opts);
  // Cloud v4 POST /runs has no startUrl / initial navigation field
  // (RunBrowserSettings.additionalProperties = false). Eve opens the
  // site via CDP after browser.ready — do not wait for the Cloud LLM.
  const body: Record<string, unknown> = {
    // Everything that reaches the task from free text — every memory line in
    // `factLines`, the whole composed brief in `sanitizeErrandBrief` — is
    // already run through `scrubSecrets` at the point it is produced. The
    // task as a whole is deliberately NOT scrubbed again here: the human's
    // own sentence travels verbatim, and a 13-digit tracking number in
    // «проверь заказ 46000123456789» is indistinguishable from a PAN to the
    // regex, so a blanket pass would silently delete the errand's subject.
    task: scaffoldTask(task, {
      profileSynced: opts?.profileSynced,
      pay: opts?.pay,
      login: opts?.login,
      startPage: opts?.startPage,
      continuation: opts?.continuation,
      ...(opts?.humanText ? { humanText: opts.humanText } : {}),
      ...briefing,
    }),
  };
  // v4 POST /runs rejects unknown keys outright (422 extra_forbidden) —
  // `session_id` is not a real field, only `sessionId` is; sending both
  // used to fail every session-reusing call (fresh-start login continuation,
  // inject/resume, and now `continue`).
  if (sessionId) {
    body.sessionId = sessionId;
  }
  const country = resolveProxyCountry();
  body.browserSettings = {
    ...(country ? { proxyCountryCode: country } : {}),
    ...(opts?.profileId ? { profileId: opts.profileId } : {}),
  };
  const maxCost = Number(process.env.BRO_BROWSER_MAX_COST ?? "1");
  if (Number.isFinite(maxCost) && maxCost > 0) body.maxCostUsd = maxCost;
  body.model = resolveBrowserModel();
  if (opts?.secretBindings && opts.secretBindings.length > 0) {
    body.secretBindings = opts.secretBindings;
  }
  // A validation error can echo the offending field back; never let a bound
  // card value ride along in the thrown message when bindings are attached.
  const created = await bu("/runs", {
    method: "POST",
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    const status =
      body.secretBindings && err instanceof Error
        ? /^browser-use (\d{3})/.exec(err.message)?.[1]
        : undefined;
    if (!status) throw err;
    throw new Error(`browser-use ${status} /runs (paid run, response redacted)`);
  });
  const runId =
    pick(created, ["id", "runId", "run_id"]) ??
    (typeof created.run === "object" && created.run
      ? pick(created.run as Record<string, unknown>, ["id"])
      : undefined);
  if (!runId) throw new Error(`browser-use create: no id in ${JSON.stringify(created).slice(0, 400)}`);
  const sid =
    pick(created, ["sessionId", "session_id"]) ??
    (typeof created.session === "object" && created.session
      ? pick(created.session as Record<string, unknown>, ["id"])
      : undefined);
  return hydrate(runId, sid);
}

async function runEvents(runId: string): Promise<unknown> {
  return await bu(runEventsPath(runId)).catch(() => undefined);
}

export type QueuedMessage = {
  id?: number;
  sessionId?: string;
  runId?: string;
  mode?: string;
  status?: string;
};

/**
 * Append a message to a live Cloud session (v4 POST /sessions/{id}/queue).
 * A session holds conversation history and keeps its browser, so the queued
 * text is handled on the already-open tab — this is how a code / correction /
 * «подожди» reaches the live login without starting a fresh browser.
 * `interrupt` cancels an active run so the message runs immediately.
 */
export async function queueMessage(
  sessionId: string,
  text: string,
  opts?: { interrupt?: boolean; attachedFileIds?: string[] },
): Promise<QueuedMessage> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("queueMessage: empty text");
  const body: Record<string, unknown> = { text: trimmed };
  if (opts?.interrupt) body.interrupt = true;
  if (opts?.attachedFileIds && opts.attachedFileIds.length > 0) {
    body.attachedFileIds = opts.attachedFileIds;
  }
  const res = await bu(`/sessions/${sessionId}/queue`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const id = typeof res.id === "number" ? res.id : undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    sessionId: pick(res, ["sessionId", "session_id"]) ?? sessionId,
    ...(pick(res, ["runId", "run_id"]) ? { runId: pick(res, ["runId", "run_id"]) } : {}),
    ...(pick(res, ["mode"]) ? { mode: pick(res, ["mode"]) } : {}),
    ...(pick(res, ["status"]) ? { status: pick(res, ["status"]) } : {}),
  };
}

export type SessionInfo = {
  sessionId: string;
  status: string;
  latestRunId?: string;
};

/** GET /sessions/{id}: session status + latest run id (for follow-through). */
export async function sessionInfo(
  sessionId: string,
): Promise<SessionInfo | undefined> {
  const res = await bu(`/sessions/${sessionId}`).catch(() => undefined);
  if (!res) return undefined;
  const latest = pick(res, ["latestRunId", "latest_run_id"]);
  return {
    sessionId: pick(res, ["sessionId", "session_id", "id"]) ?? sessionId,
    status: pick(res, ["status"]) ?? "unknown",
    ...(latest ? { latestRunId: latest } : {}),
  };
}

/**
 * After queueing into a session, find the run that will carry the follow-up.
 * The queued message may spawn a new run (new latestRunId) or resume the
 * existing one (same id, session goes active again). Wait briefly for either
 * so follow-through does not latch onto the just-finished run and report
 * "done" before the code was even applied.
 */
export async function resolveQueuedRun(
  sessionId: string,
  priorRunId: string | undefined,
  queued: QueuedMessage,
  opts?: { ms?: number; nowFn?: () => number },
): Promise<{ runId?: string; status?: string }> {
  const active = new Set([
    "queued",
    "pending",
    "dispatching",
    "running",
    "started",
    "in_progress",
    "working",
    "processing",
  ]);
  if (queued.runId && queued.runId !== priorRunId) {
    return { runId: queued.runId, ...(queued.status ? { status: queued.status } : {}) };
  }
  const now = opts?.nowFn ?? Date.now;
  const deadline = now() + (opts?.ms ?? 6_000);
  let last: SessionInfo | undefined;
  for (;;) {
    last = await sessionInfo(sessionId);
    if (last?.latestRunId && last.latestRunId !== priorRunId) {
      return { runId: last.latestRunId, status: last.status };
    }
    if (
      last?.latestRunId &&
      active.has(last.status.trim().toLowerCase())
    ) {
      return { runId: last.latestRunId, status: last.status };
    }
    if (now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const runId = last?.latestRunId ?? queued.runId ?? priorRunId;
  const status = last?.status;
  // Never hand back the just-finished/cancelled prior run as if it were the
  // follow-up: waitForRun would see a terminal status and report "done" before
  // the queued message ran. Report it as still running so the caller keeps
  // following (the background follow-through catches the real resumed run).
  if (runId === priorRunId && status && isTerminal(status)) {
    return { runId, status: "running" };
  }
  return { runId, ...(status ? { status } : {}) };
}

function withLanding(
  run: BrowserRun,
  events: unknown,
  targetPage?: string,
): BrowserRun {
  const pageUrl = pageUrlFromEvents(events, targetPage) ?? run.pageUrl;
  const liveUrl = run.liveUrl ?? liveUrlFromRunPayloads({ events });
  const landed = targetPage
    ? loginLandingReady({ liveUrl, targetPage, events, pageUrl })
    : run.landed;
  return {
    ...run,
    ...(liveUrl ? { liveUrl } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(targetPage !== undefined ? { landed } : {}),
  };
}

export async function findBrowserForSession(
  sessionId?: string,
): Promise<CloudBrowser | undefined> {
  if (!sessionId) return undefined;
  return browserFromList(await bu("/browsers"), sessionId);
}

/**
 * POST /runs/{id}/cancel — idempotent, blocks further billing on that run.
 * https://docs.browser-use.com/cloud/api-v4/runs/cancel-run
 * Best effort: 404 (already gone) is fine; never throw to callers.
 */
export async function cancelRun(runId: string): Promise<boolean> {
  try {
    await bu(`/runs/${runId}/cancel`, { method: "POST" });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/^browser-use 404\b/.test(msg) || /^browser-use 409\b/.test(msg)) return true;
    console.error("browser cancel run failed", err);
    return false;
  }
}

/**
 * PATCH /browsers/{id} {"action":"stop"} — a completed run does not stop its
 * cloud browser on its own; stop it explicitly so a fresh errand gets a fresh
 * session instead of billing an abandoned one until the 4h hard cap.
 * https://docs.browser-use.com/cloud/api-v4/browsers/update-browser-session
 */
export async function stopBrowserForSession(sessionId: string): Promise<boolean> {
  try {
    const browser = await findBrowserForSession(sessionId);
    if (!browser?.id) return false;
    await bu(`/browsers/${browser.id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "stop" }),
    });
    return true;
  } catch (err) {
    console.error("browser stop session failed", err);
    return false;
  }
}

async function applyCdpPage(
  run: BrowserRun,
  targetPage?: string,
): Promise<BrowserRun> {
  const browser = await findBrowserForSession(run.sessionId).catch(() => undefined);
  const liveUrl = run.liveUrl ?? browser?.liveUrl;
  if (!browser?.cdpUrl) {
    return liveUrl && liveUrl !== run.liveUrl ? { ...run, liveUrl } : run;
  }
  const pageUrl = await cdpPageUrl(browser.cdpUrl).catch(() => undefined);
  const next: BrowserRun = {
    ...run,
    ...(liveUrl ? { liveUrl } : {}),
    ...(pageUrl ? { pageUrl } : {}),
  };
  if (!targetPage) return next;
  return {
    ...next,
    landed: loginLandingReady({
      liveUrl: next.liveUrl,
      targetPage,
      pageUrl: next.pageUrl,
    }),
  };
}

export async function hydrate(
  runId: string,
  sessionId?: string,
  targetPage?: string,
): Promise<BrowserRun> {
  // Every other enrichment fetch below is already optional/`.catch()`-guarded;
  // this one is the one every caller treats as load-bearing, so a transient
  // Browser Use hiccup must degrade to "still looking", never throw mid-turn.
  const run = await bu(`/runs/${runId}`).catch((err: unknown) => {
    console.error("browser run fetch failed", err);
    return undefined;
  });
  if (!run) return { runId, sessionId, status: "unknown" };
  const status = pick(run, ["status"]) ?? "unknown";
  const nestedLive = liveUrlFromRunPayloads({ run });
  const session: Record<string, unknown> =
    sessionId && (isTerminal(status) || !nestedLive)
      ? await bu(`/sessions/${sessionId}`).catch(() => ({}))
      : {};
  const sid =
    sessionId ??
    pick(run, ["sessionId", "session_id"]) ??
    pick(session, ["id"]);
  const events = await runEvents(runId);
  const liveUrl =
    liveUrlFromRunPayloads({ run, session, events });
  const rawResult =
    pick(run, ["result", "output"]) ??
    (typeof run.result === "object" && run.result
      ? JSON.stringify(run.result).slice(0, 2000)
      : undefined);
  const result = rawResult ? scrubSecrets(rawResult) : rawResult;
  return applyCdpPage(
    withLanding(
      { runId, sessionId: sid, status, liveUrl, result },
      events,
      targetPage,
    ),
    targetPage,
  );
}

export async function waitForRun(
  runId: string,
  sessionId?: string,
  ms = 12_000,
): Promise<BrowserRun> {
  const start = Date.now();
  let last: BrowserRun = { runId, sessionId, status: "unknown" };
  while (Date.now() - start < ms) {
    const cheap = await bu(`/runs/${runId}/status`).catch(() => ({}));
    const status = pick(cheap, ["status"]) ?? last.status;
    if (isTerminal(status)) return hydrate(runId, last.sessionId ?? sessionId);
    last = { ...last, status };
    const remaining = ms - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(2000, remaining)));
  }
  return hydrate(runId, last.sessionId ?? sessionId);
}

/**
 * Documented v4 run terminal states (completed|failed|cancelled) plus our own
 * `stalled` sentinel. Confirmed against docs.browser-use.com/cloud/api-v4 —
 * no `stopped`/`error`/`canceled` value is ever emitted by the API.
 */
export function isTerminal(status: string): boolean {
  return DONE.has(status.trim().toLowerCase());
}

export async function waitForLiveUrl(
  run: BrowserRun,
  ms = 12_000,
): Promise<BrowserRun> {
  if (run.liveUrl) return run;
  const start = Date.now();
  let last = run;
  while (Date.now() - start < ms) {
    const events = await runEvents(last.runId);
    last = withLanding(last, events);
    const fromEvents = liveUrlFromRunPayloads({ events });
    if (fromEvents) return { ...last, liveUrl: fromEvents };
    last = await hydrate(last.runId, last.sessionId);
    if (last.liveUrl) return last;
    const remaining = ms - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(1000, remaining)));
  }
  return last;
}

/** Wait until live preview exists AND the real tab is the target site. */
export async function waitForPageLanding(
  run: BrowserRun,
  targetPage: string,
  ms = 45_000,
): Promise<BrowserRun> {
  const start = Date.now();
  let last = run;
  let navigated = false;
  while (Date.now() - start < ms) {
    last = await hydrate(last.runId, last.sessionId, targetPage);
    if (last.liveUrl && last.landed) return last;
    const browser = await findBrowserForSession(last.sessionId).catch(
      () => undefined,
    );
    const liveUrl = last.liveUrl ?? browser?.liveUrl;
    if (browser?.cdpUrl && liveUrl && !navigated) {
      const after = await cdpNavigate(browser.cdpUrl, targetPage).catch(
        (err: unknown) => {
          console.error("cdp page navigate failed", err);
          return undefined;
        },
      );
      navigated = true;
      if (after && loginHostsMatch(targetPage, after)) {
        return { ...last, liveUrl, pageUrl: after, landed: true };
      }
    }
    const remaining = ms - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(1500, remaining)));
  }
  return last.landed !== undefined
    ? last
    : { ...last, landed: false };
}

/** Login wait: same as page landing, longer budget for the form. */
export async function waitForLoginLanding(
  run: BrowserRun,
  targetPage: string,
  ms = 45_000,
): Promise<BrowserRun> {
  return waitForPageLanding(run, targetPage, ms);
}
