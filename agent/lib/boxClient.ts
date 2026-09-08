export const BOX_API_BASE = "https://ascii.dev/api/box/v1";

export type BoxType = "small" | "default" | "large";

export type BoxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error";

export type BoxRecord = {
  id: string;
  name?: string;
  state: BoxState;
  archiveAfter?: number | null;
  type?: BoxType;
  url?: string;
};

export type BoxLimits = {
  canStart: boolean;
  startBlockedReason?: string;
  starts?: {
    day?: {
      remaining?: number;
      limit?: number;
    };
  };
};

export type BoxCommandResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CreateBoxInput = {
  type?: BoxType;
  noEnv?: boolean;
  ttlSeconds?: number;
  env?: Record<string, string>;
  idempotencyKey?: string;
};

export type UpdateBoxInput = {
  name?: string;
  ttlSeconds?: number;
};

export type StopBoxInput = {
  force?: boolean;
};

export type ResumeBoxInput = {
  noEnv?: boolean;
  ttlSeconds?: number;
  type?: BoxType;
};

export type CommandBoxInput = {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
};

export type BoxClient = {
  create(input?: CreateBoxInput): Promise<BoxRecord>;
  fork(boxId: string, input?: CreateBoxInput): Promise<BoxRecord>;
  get(boxId: string): Promise<BoxRecord>;
  update(boxId: string, input: UpdateBoxInput): Promise<BoxRecord>;
  stop(boxId: string, input?: StopBoxInput): Promise<BoxRecord>;
  remove(boxId: string): Promise<void>;
  resume(boxId: string, input?: ResumeBoxInput): Promise<BoxRecord>;
  command(boxId: string, input: CommandBoxInput): Promise<BoxCommandResult>;
  readFile(boxId: string, path: string): Promise<string>;
  writeFile(boxId: string, path: string, content: string): Promise<void>;
  limits(): Promise<BoxLimits>;
  waitUntil(
    boxId: string,
    states: BoxState[],
    timeoutMs?: number,
  ): Promise<BoxRecord>;
};

export type BoxClientOpts = {
  apiKey?: string;
  orgId?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
};

const BOX_STATES: ReadonlySet<string> = new Set<BoxState>([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
]);

const BOX_TYPES: ReadonlySet<string> = new Set<BoxType>([
  "small",
  "default",
  "large",
]);

export class BoxHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "BoxHttpError";
    this.status = status;
    this.code = code;
  }
}

export function createBoxClient(opts: BoxClientOpts = {}): BoxClient {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (opts.baseUrl ?? BOX_API_BASE).replace(/\/$/, "");

  function apiKey(): string {
    const key = opts.apiKey ?? process.env.BOX_API_KEY;
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new Error("BOX_API_KEY missing");
    }
    return key.trim();
  }

  function orgId(): string | undefined {
    const id = opts.orgId ?? process.env.BOX_ORG_ID;
    if (typeof id !== "string") return undefined;
    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  async function request(
    method: string,
    path: string,
    extra?: {
      body?: unknown;
      query?: Record<string, string>;
      idempotencyKey?: string;
    },
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    if (extra?.query) {
      for (const [k, v] of Object.entries(extra.query)) {
        url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey()}`,
      Accept: "application/json",
    };
    const org = orgId();
    if (org) headers["X-Box-Org"] = org;
    if (extra?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (extra?.idempotencyKey) {
      headers["Idempotency-Key"] = extra.idempotencyKey;
    }
    const res = await fetchFn(url.href, {
      method,
      headers,
      body: extra?.body !== undefined ? JSON.stringify(extra.body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = {};
      }
    }
    if (!res.ok) {
      throw toBoxHttpError(res.status, parsed);
    }
    return parsed;
  }

  async function create(input: CreateBoxInput = {}): Promise<BoxRecord> {
    const { idempotencyKey, ...fields } = input;
    return parseBox(
      await request("POST", "/boxes", {
        body: omitUndefined(fields),
        idempotencyKey,
      }),
    );
  }

  function boxPath(boxId: string, suffix = ""): string {
    return `/boxes/${encodeURIComponent(boxId)}${suffix}`;
  }

  async function fork(
    boxId: string,
    input: CreateBoxInput = {},
  ): Promise<BoxRecord> {
    const { idempotencyKey, ...fields } = input;
    return parseBox(
      await request("POST", boxPath(boxId, "/fork"), {
        body: omitUndefined(fields),
        idempotencyKey,
      }),
    );
  }

  async function get(boxId: string): Promise<BoxRecord> {
    return parseBox(await request("GET", boxPath(boxId)));
  }

  async function update(
    boxId: string,
    input: UpdateBoxInput,
  ): Promise<BoxRecord> {
    return parseBox(
      await request("PATCH", boxPath(boxId), {
        body: omitUndefined(input),
      }),
    );
  }

  async function stop(
    boxId: string,
    input?: StopBoxInput,
  ): Promise<BoxRecord> {
    return parseBox(
      await request("POST", boxPath(boxId, "/stop"), {
        body: omitUndefined(input ?? {}),
      }),
    );
  }

  async function remove(boxId: string): Promise<void> {
    await request("DELETE", boxPath(boxId));
  }

  async function resume(
    boxId: string,
    input?: ResumeBoxInput,
  ): Promise<BoxRecord> {
    return parseBox(
      await request("POST", boxPath(boxId, "/resume"), {
        body: omitUndefined(input ?? {}),
      }),
    );
  }

  async function command(
    boxId: string,
    input: CommandBoxInput,
  ): Promise<BoxCommandResult> {
    return parseCommand(
      await request("POST", boxPath(boxId, "/commands"), {
        body: omitUndefined(input),
      }),
    );
  }

  async function readFile(boxId: string, path: string): Promise<string> {
    const raw = await request("GET", boxPath(boxId, "/files"), {
      query: { path },
    });
    const rec = asRecord(raw);
    if (typeof rec?.content !== "string") {
      throw new Error("box file missing content");
    }
    return rec.content;
  }

  async function writeFile(
    boxId: string,
    path: string,
    content: string,
  ): Promise<void> {
    await request("PUT", boxPath(boxId, "/files"), {
      body: { path, content },
    });
  }

  async function limits(): Promise<BoxLimits> {
    return parseLimits(await request("GET", "/limits"));
  }

  async function waitUntil(
    boxId: string,
    states: BoxState[],
    timeoutMs = 180_000,
  ): Promise<BoxRecord> {
    const deadline = Date.now() + timeoutMs;
    let last: BoxRecord | undefined;
    for (;;) {
      last = await get(boxId);
      if (states.includes(last.state)) return last;
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      await sleep(Math.min(500, remain));
    }
    throw new Error(
      `timeout waiting for ${states.join("|")} (last ${last?.state ?? "unknown"})`,
    );
  }

  return {
    create,
    fork,
    get,
    update,
    stop,
    remove,
    resume,
    command,
    readFile,
    writeFile,
    limits,
    waitUntil,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function omitUndefined(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function isBoxState(value: unknown): value is BoxState {
  return typeof value === "string" && BOX_STATES.has(value);
}

function isBoxType(value: unknown): value is BoxType {
  return typeof value === "string" && BOX_TYPES.has(value);
}

function parseArchiveAfter(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function parseBox(raw: unknown): BoxRecord {
  const rec = asRecord(raw) ?? {};
  const box = asRecord(rec.box) ?? rec;
  if (typeof box.id !== "string" || box.id.length === 0) {
    throw new Error("box id missing");
  }
  if (!isBoxState(box.state)) {
    throw new Error("box state invalid");
  }
  const record: BoxRecord = { id: box.id, state: box.state };
  if (typeof box.name === "string") record.name = box.name;
  if (isBoxType(box.type)) record.type = box.type;
  if (typeof box.url === "string" && box.url.length > 0) record.url = box.url;
  const archiveAfter = parseArchiveAfter(box.archiveAfter);
  if (archiveAfter !== undefined) record.archiveAfter = archiveAfter;
  return record;
}

function parseCommand(raw: unknown): BoxCommandResult {
  const rec = asRecord(raw) ?? {};
  return {
    success: rec.success === true,
    exitCode: typeof rec.exitCode === "number" ? rec.exitCode : null,
    stdout: typeof rec.stdout === "string" ? rec.stdout : "",
    stderr: typeof rec.stderr === "string" ? rec.stderr : "",
    timedOut: rec.timedOut === true,
  };
}

function parseLimits(raw: unknown): BoxLimits {
  const rec = asRecord(raw) ?? {};
  const startsRec = asRecord(rec.starts);
  const dayRec = asRecord(startsRec?.day);
  const day: { remaining?: number; limit?: number } = {};
  if (typeof dayRec?.remaining === "number") day.remaining = dayRec.remaining;
  if (typeof dayRec?.limit === "number") day.limit = dayRec.limit;
  const starts =
    startsRec === undefined
      ? undefined
      : Object.keys(day).length > 0
        ? { day }
        : {};
  const limits: BoxLimits = {
    canStart: rec.canStart === true,
    starts,
  };
  if (typeof rec.startBlockedReason === "string") {
    limits.startBlockedReason = rec.startBlockedReason;
  }
  return limits;
}

function toBoxHttpError(status: number, body: unknown): BoxHttpError {
  const rec = asRecord(body);
  const nested = asRecord(rec?.error);
  const code =
    (typeof rec?.code === "string" && rec.code) ||
    (typeof nested?.code === "string" && nested.code) ||
    "http_error";
  const message =
    (typeof rec?.message === "string" && rec.message) ||
    (typeof nested?.message === "string" && nested.message) ||
    code;
  return new BoxHttpError(status, code, message);
}
