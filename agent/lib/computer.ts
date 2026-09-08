import { posix as posixPath } from "node:path";
import {
  BoxHttpError,
  createBoxClient,
  type BoxClient,
  type BoxRecord,
  type BoxState,
} from "./boxClient.ts";
import {
  bindComputer,
  claimComputer,
  deleteComputer,
  getComputer,
  setComputerState,
  spendComputerStart,
  touchComputer,
  type ComputerRow,
} from "./convex.ts";
import { groupPersonalBlock } from "./group-guard.ts";
import { requirePersonalPhone, tenantId } from "./tenant.ts";
import {
  BRO_COMPUTER_START_RESERVE,
  BRO_COMPUTER_TTL_SECONDS,
  canSpendStart,
  nextCommandAction,
  shouldRenewTtl,
} from "../../convex/lib/computerPolicy.ts";

const HOME = "/home/user";
const TMP = "/tmp";
export const WRITE_MAX_BYTES = 256 * 1024;
export const READ_MAX_BYTES = 64 * 1024;
export const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
export const RECORD_SECONDS_MIN = 1;
export const RECORD_SECONDS_MAX = 60;
export const DESKTOP_CAPTURE_MARK = "bro-desktop-capture";
const EXEC_TIMEOUT_MAX = 240;
const SETTLE_ROUNDS = 8;
const WAIT_READY_MS = 180_000;

const COMMAND_STATES: BoxState[] = ["ready", "idle", "running"];
const WAIT_STATES: BoxState[] = ["ready", "idle", "running", "archived"];

export type ComputerSize = "small" | "default" | "large";

export type ComputerStore = {
  get(phoneE164: string): Promise<ComputerRow | null>;
  claim(
    phoneE164: string,
    opts?: { size?: ComputerSize; now?: number },
  ): Promise<ComputerRow | null>;
  bind(
    phoneE164: string,
    boxId: string,
    lastState: string,
    now?: number,
  ): Promise<ComputerRow | null>;
  setState(
    phoneE164: string,
    lastState: string,
    now?: number,
  ): Promise<ComputerRow | null>;
  touch(phoneE164: string, now?: number): Promise<ComputerRow | null>;
  remove(phoneE164: string): Promise<boolean>;
  spendStart?(phoneE164: string, now?: number): Promise<boolean>;
};

export const convexComputerStore: ComputerStore = {
  get: getComputer,
  claim: claimComputer,
  bind: bindComputer,
  setState: setComputerState,
  touch: touchComputer,
  remove: deleteComputer,
  spendStart: spendComputerStart,
};

export type EnsureRunningOpts = {
  phoneE164: string;
  size?: ComputerSize;
  store?: ComputerStore;
};

export type RunningBox = { boxId: string; state: string };

export type ExecResult = {
  boxId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ComputerDenied = {
  status: "group" | "denied";
  error: string;
};

type AuthBox = {
  session: {
    auth: {
      current?: { principalId?: string | null } | null;
      initiator?: { principalId?: string | null } | null;
    };
  };
};

export class ComputerError extends Error {
  readonly status: "limit" | "invalid" | "denied" | "error";

  constructor(status: ComputerError["status"], message: string) {
    super(message);
    this.name = "ComputerError";
    this.status = status;
  }
}

export function computerFailure(err: unknown): {
  status: string;
  error: string;
} {
  if (err instanceof ComputerError) {
    return { status: err.status, error: err.message };
  }
  return {
    status: "error",
    error: err instanceof Error ? err.message : "computer failed",
  };
}

/** Dev-only override. Tools do not use this for a shared deploy box. */
export function envBoxId(): string | undefined {
  const id = process.env.BRO_COMPUTER_BOX_ID?.trim();
  return id && id.length > 0 ? id : undefined;
}

/** group / local-dev / shared → structured deny. Never throws. */
export function asPersonal(
  ctx: AuthBox,
): { phone: string } | ComputerDenied {
  const blocked = groupPersonalBlock(ctx);
  if (blocked) return { status: "group", error: blocked };
  try {
    return { phone: requirePersonalPhone(tenantId(ctx)) };
  } catch (err) {
    return {
      status: "denied",
      error:
        err instanceof Error ? err.message : "refusing shared computer principal",
    };
  }
}

/** Reject `..` and anything outside `/home/user` or `/tmp`. */
export function assertComputerPath(raw: string): string {
  const path = raw.trim();
  if (!path) throw new ComputerError("invalid", "path required");
  if (path.includes("\0") || path.includes("..")) {
    throw new ComputerError("denied", "path escapes computer jail");
  }
  const resolved = posixPath.resolve("/", path);
  const allowed =
    resolved === HOME ||
    resolved.startsWith(`${HOME}/`) ||
    resolved === TMP ||
    resolved.startsWith(`${TMP}/`);
  if (!allowed) {
    throw new ComputerError("denied", "path must be under /home/user or /tmp");
  }
  return resolved;
}

export function assertWriteContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) {
    throw new ComputerError("invalid", "content exceeds 256KB");
  }
}

function clampTimeout(timeoutSeconds?: number): number | undefined {
  if (timeoutSeconds === undefined) return undefined;
  return Math.min(Math.max(1, Math.floor(timeoutSeconds)), EXEC_TIMEOUT_MAX);
}

function storeOf(opts: EnsureRunningOpts): ComputerStore {
  return opts.store ?? convexComputerStore;
}

function startInput(
  tenantConvexId: string,
  claimId: string,
  size: ComputerSize = "small",
): {
  type: ComputerSize;
  noEnv: true;
  ttlSeconds: number;
  env: { TENANT_ID: string };
  idempotencyKey: string;
} {
  return {
    type: size,
    noEnv: true,
    ttlSeconds: BRO_COMPUTER_TTL_SECONDS,
    env: { TENANT_ID: tenantConvexId },
    idempotencyKey: `bro:${tenantConvexId}:${claimId}`,
  };
}

async function maybeRenewTtl(
  client: BoxClient,
  box: BoxRecord,
): Promise<BoxRecord> {
  if (!shouldRenewTtl(box.archiveAfter, Date.now(), BRO_COMPUTER_TTL_SECONDS)) {
    return box;
  }
  return await client.update(box.id, { ttlSeconds: BRO_COMPUTER_TTL_SECONDS });
}

async function assertCanStart(
  client: BoxClient,
  store: ComputerStore,
  phoneE164: string,
): Promise<void> {
  if (store.spendStart) {
    const allowed = await store.spendStart(phoneE164);
    if (!allowed) throw new ComputerError("limit", "computer start limit reached");
  }
  const limits = await client.limits();
  if (
    !canSpendStart({
      canStart: limits.canStart,
      remaining: limits.starts?.day?.remaining,
      reserve: BRO_COMPUTER_START_RESERVE,
    })
  ) {
    throw new ComputerError("limit", "computer start limit reached");
  }
}

async function settle(
  client: BoxClient,
  box: BoxRecord,
  store: ComputerStore,
  phoneE164: string,
): Promise<BoxRecord> {
  let current = box;
  for (let i = 0; i < SETTLE_ROUNDS; i++) {
    const action = nextCommandAction(current.state);
    if (action === "command") {
      return await maybeRenewTtl(client, current);
    }
    if (action === "resume") {
      await assertCanStart(client, store, phoneE164);
      current = await client.resume(current.id, {
        noEnv: true,
        ttlSeconds: BRO_COMPUTER_TTL_SECONDS,
      });
      current = await client.waitUntil(current.id, COMMAND_STATES, WAIT_READY_MS);
      continue;
    }
    if (action === "wait") {
      current = await client.waitUntil(current.id, WAIT_STATES, WAIT_READY_MS);
      continue;
    }
    throw new ComputerError("error", `computer is not ready (${current.state})`);
  }
  throw new ComputerError("error", "computer did not become ready");
}

async function startBox(
  client: BoxClient,
  tenantConvexId: string,
  claimId: string,
  size: ComputerSize,
  store: ComputerStore,
  phoneE164: string,
): Promise<BoxRecord> {
  await assertCanStart(client, store, phoneE164);
  const input = startInput(tenantConvexId, claimId, size);
  const template = process.env.BOX_TEMPLATE_ID?.trim();
  const created = template
    ? await client.fork(template, input)
    : await client.create(input);
  try {
    await client.update(created.id, { name: `bro-${tenantConvexId}` });
  } catch {
    // name is cosmetic
  }
  return created;
}

/**
 * Claim the tenant row first, then create/fork ASCII, then bind.
 * Phone never goes to ASCII. BOX_API_KEY never enters the VM.
 */
export async function ensureRunning(
  opts: EnsureRunningOpts,
  client: BoxClient = createBoxClient(),
): Promise<RunningBox> {
  const store = storeOf(opts);
  const claimed = await store.claim(opts.phoneE164, { size: opts.size });
  if (!claimed) throw new ComputerError("denied", "unknown tenant");

  let boxId = claimed.boxId;
  if (!boxId) {
    const created = await startBox(
      client,
      claimed.tenantId,
      claimed._id,
      opts.size ?? "small",
      store,
      opts.phoneE164,
    );
    const bound = await store.bind(
      opts.phoneE164,
      created.id,
      created.state,
    );
    const winner = bound?.boxId ?? created.id;
    if (winner !== created.id) {
      try {
        await client.stop(created.id);
      } catch {
        // orphan billed until TTL
      }
    }
    boxId = winner;
  }

  const got = await client.get(boxId);
  const ready = await settle(client, got, store, opts.phoneE164);
  await store.setState(opts.phoneE164, ready.state);
  await store.touch(opts.phoneE164);
  return { boxId: ready.id, state: ready.state };
}

export async function ensureSession(
  opts: EnsureRunningOpts,
  client?: BoxClient,
): Promise<RunningBox> {
  return await ensureRunning(opts, client);
}

export async function boundBoxId(
  phoneE164: string,
  store: ComputerStore = convexComputerStore,
): Promise<string | null> {
  const row = await store.get(phoneE164);
  return row?.boxId ?? null;
}

async function withStartingWait<T>(
  client: BoxClient,
  boxId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const starting =
      err instanceof BoxHttpError &&
      (err.status === 409 || err.code === "box_starting");
    if (!starting) throw err;
    await client.waitUntil(boxId, COMMAND_STATES, WAIT_READY_MS);
    return await fn();
  }
}

export async function exec(
  boxId: string,
  command: string,
  cwd?: string,
  timeoutSeconds?: number,
  client: BoxClient = createBoxClient(),
): Promise<ExecResult> {
  const cmd = command.trim();
  if (!cmd) throw new ComputerError("invalid", "command required");
  const timeout = clampTimeout(timeoutSeconds);
  const result = await withStartingWait(client, boxId, async () => {
    const work = client.command(boxId, {
      command: cmd,
      ...(cwd ? { cwd: assertComputerPath(cwd) } : {}),
      ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
    });
    if (timeout === undefined) return await work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ComputerError("error", "command timed out"));
          }, timeout * 1000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
  return {
    boxId,
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function readFile(
  boxId: string,
  path: string,
  client: BoxClient = createBoxClient(),
): Promise<{ boxId: string; path: string; content: string }> {
  const safe = assertComputerPath(path);
  const content = await withStartingWait(client, boxId, () =>
    client.readFile(boxId, safe),
  );
  if (Buffer.byteLength(content, "utf8") > READ_MAX_BYTES) {
    throw new ComputerError("invalid", "file exceeds 64KB");
  }
  return { boxId, path: safe, content };
}

export function clampRecordSeconds(seconds?: number): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return 10;
  return Math.min(
    RECORD_SECONDS_MAX,
    Math.max(RECORD_SECONDS_MIN, Math.floor(seconds)),
  );
}

/** In-box capture. Display is the ASCII desktop (X + ffmpeg). */
export function buildScreenshotCommand(): string {
  return [
    `# ${DESKTOP_CAPTURE_MARK} screenshot`,
    "set -eu",
    "mkdir -p /home/user/screens",
    'OUT="/home/user/screens/shot-$(date +%s).png"',
    'DISP="${DISPLAY:-:0}"',
    'DISP="${DISP%%.*}"',
    'if ffmpeg -y -hide_banner -loglevel error -f x11grab -video_size 1920x1080 -i "${DISP}.0" -frames:v 1 "$OUT"; then',
    '  printf "%s\\n" "$OUT"',
    "  exit 0",
    "fi",
    'if command -v import >/dev/null 2>&1 && DISPLAY="$DISP" import -window root "$OUT"; then',
    '  printf "%s\\n" "$OUT"',
    "  exit 0",
    "fi",
    'echo "desktop screenshot failed" >&2',
    "exit 1",
  ].join("\n");
}

export function buildRecordCommand(seconds?: number): string {
  const sec = clampRecordSeconds(seconds);
  return [
    `# ${DESKTOP_CAPTURE_MARK} record`,
    "set -eu",
    "mkdir -p /home/user/recordings",
    'OUT="/home/user/recordings/rec-$(date +%s).mp4"',
    'DISP="${DISPLAY:-:0}"',
    'DISP="${DISP%%.*}"',
    `ffmpeg -y -hide_banner -loglevel error -f x11grab -video_size 1920x1080 -i "\${DISP}.0" -t ${sec} -c:v libx264 -pix_fmt yuv420p -an "$OUT"`,
    'printf "%s\\n" "$OUT"',
  ].join("\n");
}

function capturePathFromStdout(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (!last) throw new ComputerError("error", "desktop capture produced no file");
  return assertComputerPath(last);
}

export async function readBinaryFile(
  boxId: string,
  path: string,
  client: BoxClient = createBoxClient(),
): Promise<{ boxId: string; path: string; base64: string; bytes: number }> {
  const safe = assertComputerPath(path);
  const content = await withStartingWait(client, boxId, () =>
    client.readFile(boxId, safe, "base64"),
  );
  const trimmed = content.trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(trimmed) || trimmed.length === 0) {
    throw new ComputerError("error", "desktop file is not readable");
  }
  const bytes = Buffer.byteLength(trimmed, "base64");
  if (bytes > CAPTURE_MAX_BYTES) {
    throw new ComputerError("invalid", "capture exceeds 4MB");
  }
  return { boxId, path: safe, base64: trimmed, bytes };
}

export async function screenshotDesktop(
  boxId: string,
  client: BoxClient = createBoxClient(),
): Promise<{ boxId: string; path: string; base64: string; bytes: number }> {
  const result = await exec(boxId, buildScreenshotCommand(), undefined, 45, client);
  if (result.exitCode !== 0) {
    throw new ComputerError(
      "error",
      result.stderr.trim() || "desktop screenshot failed",
    );
  }
  return await readBinaryFile(boxId, capturePathFromStdout(result.stdout), client);
}

export async function recordDesktop(
  boxId: string,
  seconds?: number,
  client: BoxClient = createBoxClient(),
): Promise<{ boxId: string; path: string; seconds: number }> {
  const sec = clampRecordSeconds(seconds);
  const result = await exec(
    boxId,
    buildRecordCommand(sec),
    undefined,
    sec + 30,
    client,
  );
  if (result.exitCode !== 0) {
    throw new ComputerError(
      "error",
      result.stderr.trim() || "desktop recording failed",
    );
  }
  return { boxId, path: capturePathFromStdout(result.stdout), seconds: sec };
}

export async function writeFile(
  boxId: string,
  path: string,
  content: string,
  client: BoxClient = createBoxClient(),
): Promise<{ boxId: string; path: string }> {
  const safe = assertComputerPath(path);
  assertWriteContent(content);
  await withStartingWait(client, boxId, () =>
    client.writeFile(boxId, safe, content),
  );
  return { boxId, path: safe };
}

export async function stop(
  boxId: string,
  client: BoxClient = createBoxClient(),
): Promise<RunningBox> {
  const box = await client.stop(boxId);
  return { boxId: box.id, state: box.state };
}

function boxGone(err: unknown): boolean {
  return err instanceof BoxHttpError && (err.status === 404 || err.code === "not_found");
}

export async function wipeDisk(
  phoneE164: string,
  store: ComputerStore = convexComputerStore,
  client: BoxClient = createBoxClient(),
): Promise<{ state: "none" }> {
  const boxId = await boundBoxId(phoneE164, store);
  if (boxId) {
    try {
      await client.remove(boxId);
    } catch (err) {
      if (!boxGone(err)) {
        try {
          await client.get(boxId);
        } catch (getErr) {
          if (boxGone(getErr)) {
            await store.remove(phoneE164);
            return { state: "none" };
          }
          throw new ComputerError("error", "could not wipe computer");
        }
        throw new ComputerError("error", "could not wipe computer");
      }
    }
  }
  await store.remove(phoneE164);
  return { state: "none" };
}

export type CabinetComputerAction = "wake" | "stop" | "wipe";

/** Cabinet / eve `/internal/computer`. Never takes a boxId from the caller. */
export async function runCabinetComputerAction(
  phoneE164: string,
  action: CabinetComputerAction,
  store: ComputerStore = convexComputerStore,
  client: BoxClient = createBoxClient(),
): Promise<{ state: string }> {
  const phone = phoneE164.trim();
  if (!phone) throw new ComputerError("invalid", "phoneE164 required");
  if (action !== "wake" && action !== "stop" && action !== "wipe") {
    throw new ComputerError("invalid", "action must be wake, stop, or wipe");
  }
  if (action === "wake") {
    const running = await ensureRunning({ phoneE164: phone, store }, client);
    return { state: running.state };
  }
  if (action === "wipe") {
    return await wipeDisk(phone, store, client);
  }
  const boxId = await boundBoxId(phone, store);
  if (!boxId) return { state: "none" };
  const result = await stop(boxId, client);
  try {
    await store.setState(phone, result.state);
  } catch {
    // cache write is best-effort
  }
  return { state: result.state };
}

export async function status(
  boxId: string,
  client: BoxClient = createBoxClient(),
): Promise<RunningBox> {
  const box = await client.get(boxId);
  return { boxId: box.id, state: box.state };
}
