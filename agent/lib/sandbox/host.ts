import { z } from "zod";
import { env } from "@shared/environment";
import { signSandboxHostToken } from "./keys";

/**
 * The client of the code sandbox host's `sandboxd` (`sandbox/README.md`):
 * every call carries a fresh host token, and none logs a URL, since the
 * snapshot links in a request body are presigned.
 */

/** A request other than a command's stream is answered well inside this. */
const requestTimeoutMs = 60_000;
/** Opening a sandbox may restore its snapshot first. */
const openTimeoutMs = 120_000;
/** `sandboxd`'s own ceiling for a command that names none. */
const defaultExecTimeoutMs = 600_000;

class SandboxHostError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(`sandboxd ${String(status)} ${code}: ${message}`);
    this.name = "SandboxHostError";
    this.code = code;
    this.status = status;
  }
}

export function sandboxHostConfigured() {
  return (
    env.SANDBOX_HOST_ID !== undefined &&
    env.SANDBOX_HOST_ORIGIN !== undefined &&
    env.SANDBOX_SIGNING_KEY !== undefined
  );
}

function host() {
  const id = env.SANDBOX_HOST_ID;
  const origin = env.SANDBOX_HOST_ORIGIN;
  if (id === undefined || origin === undefined) {
    throw new Error(
      "SANDBOX_HOST_ID and SANDBOX_HOST_ORIGIN are not configured."
    );
  }
  return { id, origin };
}

function sandboxPath(sandboxId: string, rest = "") {
  return `/v1/sandboxes/${encodeURIComponent(sandboxId)}${rest}`;
}

const errorBodySchema = z
  .object({ error: z.string(), message: z.string().optional() })
  .catch({ error: "unknown" });

async function failure(response: Response) {
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const body = errorBodySchema.parse(parsed);
  return new SandboxHostError(
    response.status,
    body.error,
    body.message ?? text.slice(0, 200)
  );
}

async function send(
  method: "DELETE" | "GET" | "POST" | "PUT",
  path: string,
  init: {
    readonly body?: BodyInit;
    readonly json?: unknown;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}
) {
  const { id, origin } = host();
  const headers = new Headers({
    authorization: `Bearer ${signSandboxHostToken(id)}`,
  });
  const timeout = AbortSignal.timeout(init.timeoutMs ?? requestTimeoutMs);
  const request: RequestInit = {
    headers,
    method,
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  };
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    request.body = JSON.stringify(init.json);
  } else if (init.body !== undefined) {
    headers.set("content-type", "application/octet-stream");
    request.body = init.body;
  }
  return await fetch(`${origin}${path}`, request);
}

const openedSchema = z.object({
  created: z.boolean(),
  id: z.string(),
  ms: z.number().optional(),
  restored: z.boolean(),
  state: z.string(),
});

export interface SandboxOpenRequest {
  readonly memoryMb?: number;
  readonly snapshot: {
    readonly get: string;
    readonly key: string;
    readonly put: string;
  };
  readonly tools: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly token: string;
    readonly url: string;
  };
  readonly workspace: string;
}

/** Creates the sandbox, or takes up the live one with fresh links and token. */
export async function openSandbox(sandboxId: string, body: SandboxOpenRequest) {
  const response = await send("PUT", sandboxPath(sandboxId), {
    json: body,
    timeoutMs: openTimeoutMs,
  });
  if (!response.ok) throw await failure(response);
  return openedSchema.parse(await response.json());
}

/** Snapshots `/workspace`, then stops the sandbox; or only snapshots it. */
export async function settleSandbox(
  sandboxId: string,
  action: "snapshot" | "stop"
) {
  const response = await send("POST", sandboxPath(sandboxId, `/${action}`), {
    json: {},
    timeoutMs: openTimeoutMs,
  });
  // A sandbox already stopped by the host's idle reaper has nothing to save.
  if (response.status === 404) return;
  if (!response.ok) throw await failure(response);
  await response.body?.cancel();
}

export async function deleteSandbox(sandboxId: string) {
  const response = await send("DELETE", sandboxPath(sandboxId));
  if (response.status === 404) return;
  if (!response.ok) throw await failure(response);
  await response.body?.cancel();
}

export async function setSandboxNetwork(sandboxId: string, policy: string) {
  const response = await send("POST", sandboxPath(sandboxId, "/network"), {
    json: { policy },
  });
  if (!response.ok) throw await failure(response);
  await response.body?.cancel();
}

function filePath(sandboxId: string, path: string, extra = "") {
  return sandboxPath(
    sandboxId,
    `/files?path=${encodeURIComponent(path)}${extra}`
  );
}

/** The file's bytes, or null when there is no such file. */
export async function readSandboxFile(
  sandboxId: string,
  path: string,
  signal?: AbortSignal
) {
  const response = await send("GET", filePath(sandboxId, path), { signal });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw await failure(response);
  return new Uint8Array(await response.arrayBuffer());
}

export async function writeSandboxFile(
  sandboxId: string,
  path: string,
  content: Uint8Array,
  signal?: AbortSignal
) {
  const response = await send("PUT", filePath(sandboxId, path), {
    body: Buffer.from(content),
    signal,
  });
  if (!response.ok) throw await failure(response);
  await response.body?.cancel();
}

export async function removeSandboxPath(
  sandboxId: string,
  input: {
    readonly force?: boolean;
    readonly path: string;
    readonly recursive?: boolean;
    readonly signal?: AbortSignal;
  }
) {
  const flags = `${input.recursive === true ? "&recursive=1" : ""}${
    input.force === true ? "&force=1" : ""
  }`;
  const response = await send(
    "DELETE",
    filePath(sandboxId, input.path, flags),
    { signal: input.signal }
  );
  if (!response.ok) throw await failure(response);
  await response.body?.cancel();
}

const execEventSchema = z.discriminatedUnion("type", [
  z.object({ pid: z.string(), type: z.literal("start") }),
  z.object({ data: z.string(), type: z.literal("stdout") }),
  z.object({ data: z.string(), type: z.literal("stderr") }),
  z.object({ code: z.number().int(), type: z.literal("exit") }),
  z.object({ message: z.string(), type: z.literal("error") }),
  // Written while a command is silent, so no proxy or client gives up on
  // the stream: undici drops a body after 300 s without bytes.
  z.object({ type: z.literal("ping") }),
]);

export type SandboxExecEvent = z.infer<typeof execEventSchema>;

export interface SandboxExecRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/**
 * Runs one command and yields its events as they come: the stream is not
 * buffered on either side. Aborting `signal` closes the stream, and the host
 * kills the process.
 */
export async function* execInSandbox(
  sandboxId: string,
  request: SandboxExecRequest,
  signal: AbortSignal
): AsyncGenerator<SandboxExecEvent> {
  const { id, origin } = host();
  // The host ends the command at its timeout; the stream gets a minute more
  // to bring the exit, then gives up on a host that went silent.
  const deadline = AbortSignal.timeout(
    (request.timeoutMs ?? defaultExecTimeoutMs) + 60_000
  );
  const response = await fetch(`${origin}${sandboxPath(sandboxId, "/exec")}`, {
    body: JSON.stringify(request),
    headers: {
      authorization: `Bearer ${signSandboxHostToken(id)}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.any([signal, deadline]),
  });
  if (!response.ok) throw await failure(response);
  const reader = response.body?.getReader();
  if (!reader)
    throw new SandboxHostError(502, "no_stream", "empty exec stream");
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The stream arrives as a sequence of chunks.
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line.length > 0) yield execEventSchema.parse(JSON.parse(line));
      newline = pending.indexOf("\n");
    }
  }
  const rest = (pending + decoder.decode()).trim();
  if (rest.length > 0) yield execEventSchema.parse(JSON.parse(rest));
}

export async function killSandboxProcess(sandboxId: string, pid: string) {
  const response = await send(
    "POST",
    sandboxPath(sandboxId, `/procs/${encodeURIComponent(pid)}/kill`),
    { json: {} }
  );
  if (!response.ok && response.status !== 404) throw await failure(response);
  await response.body?.cancel();
}
