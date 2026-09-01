export class MaritimeError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "MaritimeError";
    this.status = status;
    this.code = code;
  }
}

let maritimeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export function setMaritimeFetch(fn: typeof fetch | undefined): void {
  maritimeFetch = fn ?? globalThis.fetch.bind(globalThis);
}

export function maritimeEnabled(): boolean {
  return Boolean(process.env.MARITIME_TOKEN?.trim());
}

export function maritimeBaseUrl(): string {
  const raw = process.env.MARITIME_API_URL?.trim();
  const base = raw ? raw : "https://api.maritime.sh";
  return base.replace(/\/+$/, "");
}

function token(): string {
  const value = process.env.MARITIME_TOKEN?.trim();
  if (!value) {
    throw new Error(
      "MARITIME_TOKEN missing — компьютер недоступен на этом хосте",
    );
  }
  return value;
}

function mergeSignals(
  signal?: AbortSignal,
  timeoutMs?: number,
): AbortSignal | undefined {
  const parts: AbortSignal[] = [];
  if (signal) parts.push(signal);
  if (timeoutMs !== undefined) parts.push(AbortSignal.timeout(timeoutMs));
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(body: unknown, fallback: string): string {
  const rec = asRecord(body);
  if (typeof rec.detail === "string" && rec.detail.length > 0) return rec.detail;
  const nested = asRecord(rec.error);
  if (typeof nested.message === "string" && nested.message.length > 0) {
    return nested.message;
  }
  return fallback;
}

function errorCode(body: unknown): string | undefined {
  const rec = asRecord(body);
  return typeof rec.code === "string" ? rec.code : undefined;
}

async function request<T>(
  method: string,
  path: string,
  opts?: { body?: unknown; signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token()}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await maritimeFetch(`${maritimeBaseUrl()}${path}`, {
    method,
    headers,
    body,
    signal: mergeSignals(opts?.signal, opts?.timeoutMs),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { raw: text };
    }
  }
  if (res.status < 200 || res.status >= 300) {
    throw new MaritimeError(
      errorMessage(parsed, `maritime ${res.status} ${path}`),
      res.status,
      errorCode(parsed),
    );
  }
  return parsed as T;
}

export type MaritimeAgent = {
  id: string;
  name: string;
  status: string;
  externalId: string | null;
  framework: string;
  tier: string;
  desktopEnabled: boolean;
  projectId: string | null;
  publicUrl: string | null;
  lastActiveAt: string | null;
  idleTtlSeconds: number | null;
};

export type MaritimeLiveView = {
  liveViewUrl: string | null;
  sessionId: string | null;
  startedAt: string | null;
  reason: string | null;
};

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseAgent(raw: unknown): MaritimeAgent {
  const o = asRecord(raw);
  return {
    id: str(o.id),
    name: str(o.name),
    status: str(o.status),
    externalId: strOrNull(o.externalId),
    framework: str(o.framework),
    tier: str(o.tier),
    desktopEnabled: o.desktopEnabled === true,
    projectId: strOrNull(o.projectId),
    publicUrl: strOrNull(o.publicUrl),
    lastActiveAt: strOrNull(o.lastActiveAt),
    idleTtlSeconds: numOrNull(o.idleTtlSeconds),
  };
}

function asAgentList(raw: unknown): MaritimeAgent[] {
  if (Array.isArray(raw)) return raw.map(parseAgent);
  const rec = asRecord(raw);
  for (const key of ["agents", "items", "data"] as const) {
    const value = rec[key];
    if (Array.isArray(value)) return value.map(parseAgent);
  }
  return [];
}

export async function listAgents(opts?: {
  externalId?: string;
  signal?: AbortSignal;
}): Promise<MaritimeAgent[]> {
  const qs = opts?.externalId
    ? `?externalId=${encodeURIComponent(opts.externalId)}`
    : "";
  const agents = asAgentList(
    await request("GET", `/api/agents${qs}`, { signal: opts?.signal }),
  );
  if (!opts?.externalId) return agents;
  return agents.filter((agent) => agent.externalId === opts.externalId);
}

export async function getAgent(
  id: string,
  signal?: AbortSignal,
): Promise<MaritimeAgent> {
  return parseAgent(
    await request("GET", `/api/agents/${encodeURIComponent(id)}`, { signal }),
  );
}

export async function createAgent(
  body: {
    name: string;
    templateId: string;
    externalId: string;
    instructions?: string;
    description?: string;
    desktop?: boolean;
    idleTtlSeconds?: number;
    tier?: "smart" | "extended" | "always_on";
  },
  signal?: AbortSignal,
): Promise<MaritimeAgent> {
  return parseAgent(await request("POST", "/api/agents", { body, signal }));
}

export async function provisionAgent(
  args: Parameters<typeof createAgent>[0],
  signal?: AbortSignal,
): Promise<{ agent: MaritimeAgent; created: boolean }> {
  const existing = await listAgents({ externalId: args.externalId, signal });
  const found = existing[0];
  if (found) return { agent: found, created: false };
  return { agent: await createAgent(args, signal), created: true };
}

export async function chat(
  id: string,
  message: string,
  opts?: { conversationId?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ response: string | null; error?: string }> {
  const body: { message: string; conversation_id?: string } = { message };
  if (opts?.conversationId) body.conversation_id = opts.conversationId;
  const raw = await request<unknown>(
    "POST",
    `/api/agents/${encodeURIComponent(id)}/chat`,
    {
      body,
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? 45_000,
    },
  );
  const o = asRecord(raw);
  const response = typeof o.response === "string" ? o.response : null;
  const error = typeof o.error === "string" ? o.error : undefined;
  return error !== undefined ? { response, error } : { response };
}

export async function liveView(
  id: string,
  signal?: AbortSignal,
): Promise<MaritimeLiveView> {
  const o = asRecord(
    await request(
      "GET",
      `/api/agents/${encodeURIComponent(id)}/browser/live-view`,
      { signal },
    ),
  );
  return {
    liveViewUrl: strOrNull(o.liveViewUrl),
    sessionId: strOrNull(o.sessionId),
    startedAt: strOrNull(o.startedAt),
    reason: strOrNull(o.reason),
  };
}

export async function exec(
  id: string,
  command: string | string[],
  opts?: { timeout?: number; signal?: AbortSignal },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const body: { command: string | string[]; timeout?: number } = { command };
  if (opts?.timeout !== undefined) body.timeout = opts.timeout;
  const o = asRecord(
    await request("POST", `/api/agents/${encodeURIComponent(id)}/exec`, {
      body,
      signal: opts?.signal,
    }),
  );
  return {
    exitCode: typeof o.exitCode === "number" ? o.exitCode : 0,
    stdout: typeof o.stdout === "string" ? o.stdout : "",
    stderr: typeof o.stderr === "string" ? o.stderr : "",
  };
}

export async function listFiles(
  id: string,
  path?: string,
  signal?: AbortSignal,
): Promise<{
  path: string;
  root: string;
  entries: { name: string; isDir: boolean; size: number; mtime: number }[];
}> {
  const qs = path !== undefined ? `?path=${encodeURIComponent(path)}` : "";
  const o = asRecord(
    await request(
      "GET",
      `/api/agents/${encodeURIComponent(id)}/files/list${qs}`,
      { signal },
    ),
  );
  const entries = Array.isArray(o.entries)
    ? o.entries.map((entry) => {
        const item = asRecord(entry);
        return {
          name: str(item.name),
          isDir: item.isDir === true,
          size: typeof item.size === "number" ? item.size : 0,
          mtime: typeof item.mtime === "number" ? item.mtime : 0,
        };
      })
    : [];
  return {
    path: str(o.path, path ?? "/data"),
    root: str(o.root, "/data"),
    entries,
  };
}

export async function writeFile(
  id: string,
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  await request("PUT", `/api/agents/${encodeURIComponent(id)}/files/write`, {
    body: { path, content },
    signal,
  });
}

export async function setEnv(
  id: string,
  key: string,
  value: string,
  opts?: { secret?: boolean; reload?: boolean; signal?: AbortSignal },
): Promise<void> {
  await request("POST", `/api/agents/${encodeURIComponent(id)}/env`, {
    body: { key, value, isSecret: opts?.secret === true },
    signal: opts?.signal,
  });
  if (opts?.reload) {
    await request("POST", `/api/agents/${encodeURIComponent(id)}/reload-env`, {
      signal: opts.signal,
    });
  }
}

export async function startAgent(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await request("POST", `/api/agents/${encodeURIComponent(id)}/start`, {
    signal,
  });
}

export async function sleepAgent(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await request("POST", `/api/agents/${encodeURIComponent(id)}/sleep`, {
    signal,
  });
}

export async function deleteAgent(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await request("DELETE", `/api/agents/${encodeURIComponent(id)}`, { signal });
}

export async function setDesktop(
  id: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: "paid_plan_required" }> {
  try {
    await request(
      "PATCH",
      `/api/agents/${encodeURIComponent(id)}/desktop-config`,
      { body: { enabled }, signal },
    );
    return { ok: true };
  } catch (err) {
    if (
      err instanceof MaritimeError &&
      (err.status === 402 || err.code === "seat_limit")
    ) {
      return { ok: false, reason: "paid_plan_required" };
    }
    throw err;
  }
}

export async function planUsage(
  signal?: AbortSignal,
): Promise<{ plan: string; maxAgents: number | null; agents: number }> {
  const o = asRecord(await request("GET", "/api/wallet/plan-usage", { signal }));
  const limits = asRecord(o.limits);
  const usage = asRecord(o.usage);
  return {
    plan: str(o.plan),
    maxAgents: numOrNull(limits.maxAgents),
    agents: typeof usage.agents === "number" ? usage.agents : 0,
  };
}

export async function listTemplates(
  signal?: AbortSignal,
): Promise<{ id: string; name: string }[]> {
  const raw = await request<unknown>("GET", "/api/templates", { signal });
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(asRecord(raw).templates)
      ? (asRecord(raw).templates as unknown[])
      : [];
  return list.map((item) => {
    const o = asRecord(item);
    return { id: str(o.id), name: str(o.name) };
  });
}
