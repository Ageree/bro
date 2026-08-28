const BASE = "https://api.browser-use.com/api/v4";

function key(): string {
  const k = process.env.BROWSER_USE_API_KEY;
  if (!k) throw new Error("BROWSER_USE_API_KEY missing");
  return k;
}

async function bu(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
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
};

const ERRAND_MARK = "[bro-errand]";

/** Wrap a raw errand with the cloud-browser operating envelope. Idempotent if already marked. */
export function scaffoldTask(task: string): string {
  if (task.startsWith(ERRAND_MARK)) return task;
  return `${ERRAND_MARK}
Выполняй поручение на языке сайтов (обычно русский). Задача: ${task}.
Никогда не вводи номера карт, CVV, пароли или коды из SMS. Если сайт требует логин или оплату — остановись на этом шаге и опиши, что человеку нужно сделать самому (он подключится через live-URL).
Доводи дело до конца, если оплата/логин не требуются (например: выбрать слот, заполнить форму с известными данными, дойти до финального подтверждения).
Если данных не хватает (имя, телефон, адрес, время) — не выдумывай; закончи и перечисли, что нужно уточнить.
Работай быстро: если сайт медленный, требует капчу или недоступен — пропусти его и возьми другой вариант.
В конце верни краткий структурированный итог: что сделано; что нашёл (варианты с ценами/временами, до 5); что нужно от человека.`;
}

export async function createProfile(userId: string): Promise<string> {
  const created = await bu("/profiles", {
    method: "POST",
    body: JSON.stringify({ userId, name: userId }),
  });
  const id = pick(created, ["id"]);
  if (!id) throw new Error(`browser-use profile: no id in ${JSON.stringify(created).slice(0, 400)}`);
  return id;
}

export async function startRun(
  task: string,
  sessionId?: string,
  opts?: { profileId?: string },
): Promise<BrowserRun> {
  const body: Record<string, unknown> = { task: scaffoldTask(task) };
  // Cloud JSON accepts both; send both so a session is reused.
  if (sessionId) {
    body.sessionId = sessionId;
    body.session_id = sessionId;
  }
  const proxy = process.env.BRO_BROWSER_PROXY ?? "ru";
  body.browserSettings = {
    ...(proxy !== "none" ? { proxyCountryCode: proxy } : {}),
    ...(opts?.profileId ? { profileId: opts.profileId } : {}),
  };
  const maxCost = Number(process.env.BRO_BROWSER_MAX_COST ?? "1");
  if (Number.isFinite(maxCost) && maxCost > 0) body.maxCostUsd = maxCost;
  if (process.env.BRO_BROWSER_MODEL) body.model = process.env.BRO_BROWSER_MODEL;
  const created = await bu("/runs", {
    method: "POST",
    body: JSON.stringify(body),
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

export async function hydrate(
  runId: string,
  sessionId?: string,
): Promise<BrowserRun> {
  const run = await bu(`/runs/${runId}`);
  const session = sessionId
    ? await bu(`/sessions/${sessionId}`).catch(() => ({}))
    : {};
  const sid =
    sessionId ??
    pick(run, ["sessionId", "session_id"]) ??
    pick(session, ["id"]);
  const liveUrl =
    pick(run, ["liveUrl", "live_url"]) ??
    pick(session, ["liveUrl", "live_url"]) ??
    (typeof session.browser === "object" && session.browser
      ? pick(session.browser as Record<string, unknown>, ["liveUrl", "live_url"])
      : undefined);
  const result =
    pick(run, ["result", "output"]) ??
    (typeof run.result === "object" && run.result
      ? JSON.stringify(run.result).slice(0, 2000)
      : undefined);
  const status = pick(run, ["status"]) ?? "unknown";
  return { runId, sessionId: sid, status, liveUrl, result };
}

export async function waitForRun(
  runId: string,
  sessionId?: string,
  ms = 12_000,
): Promise<BrowserRun> {
  const start = Date.now();
  let last = await hydrate(runId, sessionId);
  while (Date.now() - start < ms) {
    const cheap = await bu(`/runs/${runId}/status`).catch(() => ({}));
    const status = pick(cheap, ["status"]) ?? last.status;
    if (isTerminal(status)) return hydrate(runId, last.sessionId);
    last = { ...last, status };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return hydrate(runId, last.sessionId);
}

export function isTerminal(status: string): boolean {
  return ["completed", "failed", "cancelled", "canceled", "stopped", "error"].includes(
    status.toLowerCase(),
  );
}
