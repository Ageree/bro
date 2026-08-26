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

export async function startRun(
  task: string,
  sessionId?: string,
): Promise<BrowserRun> {
  const body: Record<string, unknown> = { task };
  // Cloud JSON accepts both; send both so a session is reused.
  if (sessionId) {
    body.sessionId = sessionId;
    body.session_id = sessionId;
  }
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

function isTerminal(status: string): boolean {
  return ["completed", "failed", "cancelled", "canceled", "stopped", "error"].includes(
    status.toLowerCase(),
  );
}
