/** Operator board: health flags and a lean event log. No message bodies. */

export const OPS_EVENT_KINDS = [
  "access_ok",
  "access_not_ios",
  "access_need_phone",
  "access_closed",
  "access_error",
  "first_bind",
  "first_message",
  "paywall",
  "turn_failed",
  "job_failed",
  "wakeup_failed",
  "payment_ok",
  "telegram_bound",
  "cabinet_login",
] as const;

export type OpsEventKind = (typeof OPS_EVENT_KINDS)[number];

export const OPS_EVENT_LABELS: Record<OpsEventKind, string> = {
  access_ok: "доступ выдан",
  access_not_ios: "не iPhone",
  access_need_phone: "нет номера",
  access_closed: "кап",
  access_error: "ошибка доступа",
  first_bind: "первый чат",
  first_message: "первое сообщение",
  paywall: "пейволл",
  turn_failed: "ход сломался",
  job_failed: "дело упало",
  wakeup_failed: "wakeup упал",
  payment_ok: "оплата",
  telegram_bound: "телеграм",
  cabinet_login: "вход в кабинет",
};

export const OPS_FLAG_LABELS = {
  never_wrote: "не писал",
  no_chat: "нет чата",
  paywall: "пейволл",
  stuck_job: "дело ждёт",
  failed_wakeup: "wakeup",
  browser: "браузер",
} as const;

export type OpsFlag = keyof typeof OPS_FLAG_LABELS;

export const OPS_DETAIL_CAP = 160;
export const OPS_EVENT_TTL_MS = 14 * 24 * 3600 * 1000;
export const STUCK_JOB_MS = 2 * 3600 * 1000;
export const STUCK_BROWSER_MS = 20 * 60 * 1000;
export const DAY_MS = 24 * 3600 * 1000;

export function isOpsEventKind(s: string): s is OpsEventKind {
  return (OPS_EVENT_KINDS as readonly string[]).includes(s);
}

export function clipOpsDetail(s: string | undefined): string | undefined {
  const t = (s ?? "").trim();
  if (!t) return undefined;
  return t.slice(0, OPS_DETAIL_CAP);
}

export function tenantProvisioned(handle: string | undefined): boolean {
  return typeof handle === "string" && handle.length > 0;
}

export function tenantHasChat(
  photonConversationId: string | undefined,
  inkboxConversationId: string | undefined,
): boolean {
  return Boolean(photonConversationId || inkboxConversationId);
}

export function accessEventKind(
  ok: boolean,
  code: string | undefined,
): OpsEventKind {
  if (ok) return "access_ok";
  if (code === "not_ios") return "access_not_ios";
  if (code === "need_phone") return "access_need_phone";
  if (code === "closed") return "access_closed";
  return "access_error";
}

export function jobIsStuck(opts: {
  status: string;
  waitingSince?: number;
  now: number;
}): boolean {
  if (opts.status !== "waiting") return false;
  if (opts.waitingSince === undefined) return true;
  return opts.now - opts.waitingSince >= STUCK_JOB_MS;
}

export function browserIsStuck(opts: {
  live: boolean;
  startedAt?: number;
  now: number;
}): boolean {
  if (!opts.live) return false;
  if (opts.startedAt === undefined) return true;
  return opts.now - opts.startedAt >= STUCK_BROWSER_MS;
}

export function tenantFlags(input: {
  provisioned: boolean;
  lastHumanAt?: number;
  hasChat: boolean;
  paywalledToday: boolean;
  stuckJob: boolean;
  failedWakeup: boolean;
  browserStuck: boolean;
}): OpsFlag[] {
  const flags: OpsFlag[] = [];
  if (input.provisioned && input.lastHumanAt === undefined) {
    flags.push("never_wrote");
  }
  if (input.provisioned && !input.hasChat) flags.push("no_chat");
  if (input.paywalledToday) flags.push("paywall");
  if (input.stuckJob) flags.push("stuck_job");
  if (input.failedWakeup) flags.push("failed_wakeup");
  if (input.browserStuck) flags.push("browser");
  return flags;
}

export type OpsBoardPerson = {
  provisioned: boolean;
  bound: boolean;
  lastHumanAt?: number;
  flags: readonly string[];
};

export type OpsBoardTotals = {
  provisioned: number;
  bound: number;
  wrote: number;
  wrote24h: number;
  neverWrote: number;
  paywalled: number;
  stuckJobs: number;
  failedWakeups: number;
  accessOk24h: number;
  accessClosed24h: number;
  accessNeedPhone24h: number;
  accessNotIos24h: number;
};

export function boardTotals(opts: {
  people: readonly OpsBoardPerson[];
  now: number;
  recentKinds: readonly string[];
}): OpsBoardTotals {
  const dayAgo = opts.now - DAY_MS;
  let provisioned = 0;
  let bound = 0;
  let wrote = 0;
  let wrote24h = 0;
  let neverWrote = 0;
  let paywalled = 0;
  let stuckJobs = 0;
  let failedWakeups = 0;
  for (const p of opts.people) {
    if (p.provisioned) provisioned += 1;
    if (p.bound) bound += 1;
    if (p.lastHumanAt !== undefined) {
      wrote += 1;
      if (p.lastHumanAt >= dayAgo) wrote24h += 1;
    }
    if (p.flags.includes("never_wrote")) neverWrote += 1;
    if (p.flags.includes("paywall")) paywalled += 1;
    if (p.flags.includes("stuck_job")) stuckJobs += 1;
    if (p.flags.includes("failed_wakeup")) failedWakeups += 1;
  }
  return {
    provisioned,
    bound,
    wrote,
    wrote24h,
    neverWrote,
    paywalled,
    stuckJobs,
    failedWakeups,
    accessOk24h: opts.recentKinds.filter((k) => k === "access_ok").length,
    accessClosed24h: opts.recentKinds.filter((k) => k === "access_closed")
      .length,
    accessNeedPhone24h: opts.recentKinds.filter((k) => k === "access_need_phone")
      .length,
    accessNotIos24h: opts.recentKinds.filter((k) => k === "access_not_ios")
      .length,
  };
}

export function compareOpsRows(
  a: { flags: readonly string[]; lastHumanAt?: number; createdAt: number },
  b: { flags: readonly string[]; lastHumanAt?: number; createdAt: number },
): number {
  const ah = a.flags.length > 0 ? 0 : 1;
  const bh = b.flags.length > 0 ? 0 : 1;
  if (ah !== bh) return ah - bh;
  const at = a.lastHumanAt ?? 0;
  const bt = b.lastHumanAt ?? 0;
  if (at !== bt) return bt - at;
  return b.createdAt - a.createdAt;
}
