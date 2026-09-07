export const BROWSER_JOB_IDLE = "Сейчас ничего не делает";
export const BROWSER_JOB_RUNNING = "Bro ищет / оформляет";
export const BROWSER_JOB_SECURE = "Ждёт 3-D Secure";
export const BROWSER_JOB_DONE = "Готово";
export const BROWSER_JOB_FAILED = "Не вышло";

const IDLE = new Set(["", "missing", "empty"]);
const COMPLETED = new Set(["completed"]);
const FAILED = new Set([
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
]);

export type BrowserJobTenant = {
  browserStatus?: string;
  browserTask?: string;
  browserLiveUrl?: string;
  browserStartedAt?: number;
};

export type BrowserJobSnapshot = {
  status: string;
  label: string;
  task?: string;
  liveUrl?: string;
  startedAt?: number;
};

function compactStatus(status: string): string {
  return status.toLowerCase().replace(/[\s_-]+/g, "");
}

function looksLike3ds(status: string): boolean {
  const compact = compactStatus(status);
  return compact.includes("3ds") || compact.includes("3dsecure");
}

function jobExtras(
  tenant: BrowserJobTenant,
  includeLive: boolean,
): Pick<BrowserJobSnapshot, "task" | "liveUrl" | "startedAt"> {
  const extra: Pick<BrowserJobSnapshot, "task" | "liveUrl" | "startedAt"> = {};
  const task = tenant.browserTask?.trim();
  if (task) extra.task = task;
  if (includeLive) {
    const liveUrl = tenant.browserLiveUrl?.trim();
    if (liveUrl) extra.liveUrl = liveUrl;
  }
  if (typeof tenant.browserStartedAt === "number") {
    extra.startedAt = tenant.browserStartedAt;
  }
  return extra;
}

/** Map tenant browser-run fields to cabinet «Сейчас» copy. */
export function browserJobForSnapshot(
  tenant: BrowserJobTenant,
): BrowserJobSnapshot {
  const status = (tenant.browserStatus ?? "").trim();
  const key = status.toLowerCase();
  if (IDLE.has(key)) {
    return { status, label: BROWSER_JOB_IDLE };
  }
  if (COMPLETED.has(key)) {
    return { status, label: BROWSER_JOB_DONE, ...jobExtras(tenant, false) };
  }
  if (FAILED.has(key)) {
    return { status, label: BROWSER_JOB_FAILED, ...jobExtras(tenant, false) };
  }
  if (looksLike3ds(status)) {
    return { status, label: BROWSER_JOB_SECURE, ...jobExtras(tenant, true) };
  }
  return { status, label: BROWSER_JOB_RUNNING, ...jobExtras(tenant, true) };
}
