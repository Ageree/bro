import { z } from "zod";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxNetworkPolicy,
  SandboxProcess,
  SandboxSession,
} from "eve/sandbox";
import { presignBrowserStateObject } from "@agent/lib/browser-pool/s3";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import {
  deleteSandbox,
  execInSandbox,
  killSandboxProcess,
  openSandbox,
  readSandboxFile,
  removeSandboxPath,
  sandboxHostConfigured,
  setSandboxNetwork,
  settleSandbox,
  writeSandboxFile,
} from "./host";
import {
  maximumToolsTokenSeconds,
  sandboxIdFor,
  sandboxSnapshotKey,
  signSandboxToolsToken,
} from "./keys";
import { sandboxToolsPath } from "./router";

/**
 * eve's sandbox on the Cloud.ru code host (`sandbox/README.md`): a gVisor
 * container per durable session, run by `sandboxd`, its `/workspace` kept in
 * Object Storage between sessions of compute. The name is part of eve's
 * reconnect state and template keys: a different one starts every session's
 * sandbox afresh.
 */
const backendName = "bro-cloudru";
const workspaceRoot = "/workspace";
/**
 * What `sandboxd` records as the sandbox's owner. eve opens the sandbox
 * before `onSession` names the person's workspace, and `sandboxd` refuses
 * to hand a live sandbox to another owner, so it is one label for every
 * sandbox of this deployment; the sandbox id, from the session key, already
 * keeps sessions apart. The person's workspace rides in the tool router's
 * token, which every open renews.
 */
const sandboxOwner = "bro";
/** The snapshot links outlive any pause the host's idle reaper may need. */
const snapshotLinkSeconds = 7 * 24 * 60 * 60;
/** A command that names no limit gets the host's default ceiling. */
const defaultCommandTimeoutMs = 10 * 60_000;
/** How much of one stream of a command's output `run` keeps. */
const maximumCommandOutputBytes = 1024 * 1024;

/** What `onSession` hands the backend: whose sandbox it is. */
interface CloudRuSessionOptions {
  readonly workspaceId?: string;
}

function snapshotObjectKey(sandboxId: string) {
  return `sandbox/workspaces/${sandboxId}.snap`;
}

async function deleteSnapshot(sandboxId: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(
    presignBrowserStateObject({
      expiresSeconds: 300,
      key: snapshotObjectKey(sandboxId),
      method: "DELETE",
    }),
    {
      method: "DELETE",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }
  );
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `The sandbox snapshot was not deleted (Object Storage ${String(response.status)}).`
    );
  }
}

function toolsUrl() {
  return env.SANDBOX_TOOLS_URL ?? `${applicationOrigin()}${sandboxToolsPath}`;
}

export function resolveSandboxPath(path: string) {
  if (path.includes("\0")) throw new Error("A sandbox path may not hold NUL.");
  if (path.startsWith("/")) return path;
  const relative = path.replace(/^\.\/+/u, "");
  return relative.length === 0 ? workspaceRoot : `${workspaceRoot}/${relative}`;
}

function openRequest(sandboxId: string, workspaceId: string) {
  const key = snapshotObjectKey(sandboxId);
  return {
    snapshot: {
      get: presignBrowserStateObject({
        expiresSeconds: 60 * 60,
        key,
        method: "GET",
      }),
      key: sandboxSnapshotKey(sandboxId),
      put: presignBrowserStateObject({
        expiresSeconds: snapshotLinkSeconds,
        key,
        method: "PUT",
      }),
    },
    tools: {
      token: signSandboxToolsToken({
        sandboxId,
        ttlSeconds: maximumToolsTokenSeconds,
        workspaceId,
      }),
      url: toolsUrl(),
    },
    workspace: sandboxOwner,
  };
}

function concat(chunks: readonly Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The stream arrives as a sequence of chunks.
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concat(chunks);
}

/**
 * A command's output as text, its first `maximumCommandOutputBytes` only:
 * the rest is read and dropped, so a runaway command cannot fill the
 * server's memory. eve shows the model far less than this anyway.
 */
async function readOutput(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let dropped = 0;
  const reader = stream.getReader();
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The stream arrives as a sequence of chunks.
    const { done, value } = await reader.read();
    if (done) break;
    const room = maximumCommandOutputBytes - kept;
    if (room > 0) {
      const part = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(part);
      kept += part.byteLength;
    }
    dropped += value.byteLength - Math.max(Math.min(room, value.byteLength), 0);
  }
  const text = new TextDecoder().decode(concat(chunks));
  return dropped === 0
    ? text
    : `${text}\n[output cut: ${String(dropped)} more bytes not kept]`;
}

function sliceLines(text: string, startLine?: number, endLine?: number) {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split("\n");
  const start = Math.max((startLine ?? 1) - 1, 0);
  const end = endLine === undefined ? lines.length : Math.max(endLine, 0);
  return lines.slice(start, end).join("\n");
}

function decode(bytes: Uint8Array, encoding?: string) {
  if (encoding === undefined || /^utf-?8$/iu.test(encoding)) {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (!Buffer.isEncoding(encoding)) {
    throw new Error(`Unknown text encoding ${encoding}.`);
  }
  return Buffer.from(bytes).toString(encoding);
}

function encode(text: string, encoding?: string) {
  if (encoding === undefined || /^utf-?8$/iu.test(encoding)) {
    return new TextEncoder().encode(text);
  }
  if (!Buffer.isEncoding(encoding)) {
    throw new Error(`Unknown text encoding ${encoding}.`);
  }
  return new Uint8Array(Buffer.from(text, encoding));
}

interface CommandOptions {
  readonly abortSignal?: AbortSignal;
  readonly command: string;
  readonly env?: Record<string, string>;
  readonly workingDirectory?: string;
}

/**
 * Starts one command and hands its output over as streams. The command
 * lives as long as its stream: `kill` and the caller's abort close it, and
 * the host kills the process with it.
 */
function spawnCommand(
  sandboxId: string,
  options: CommandOptions
): SandboxProcess {
  const controller = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, controller.signal])
    : controller.signal;
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: (streamController) => {
      stdoutController = streamController;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (streamController) => {
      stderrController = streamController;
    },
  });
  let pid: string | undefined;
  const closeStreams = (error?: Error) => {
    for (const stream of [stdoutController, stderrController]) {
      try {
        if (error === undefined) stream.close();
        else stream.error(error);
      } catch {
        // Already closed.
      }
    }
  };
  const exit = (async () => {
    try {
      for await (const event of execInSandbox(
        sandboxId,
        {
          command: options.command,
          cwd: resolveSandboxPath(options.workingDirectory ?? workspaceRoot),
          env: options.env,
          timeoutMs: defaultCommandTimeoutMs,
        },
        signal
      )) {
        if (event.type === "start") pid = event.pid;
        else if (event.type === "stdout") {
          stdoutController.enqueue(Buffer.from(event.data, "base64"));
        } else if (event.type === "stderr") {
          stderrController.enqueue(Buffer.from(event.data, "base64"));
        } else if (event.type === "ping") {
          continue;
        } else if (event.type === "exit") {
          closeStreams();
          return { exitCode: event.code };
        } else {
          throw new Error(`The sandbox command failed: ${event.message}`);
        }
      }
      throw new Error("The sandbox command stream ended without an exit.");
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new Error("The sandbox command failed.");
      closeStreams(failure);
      throw failure;
    }
  })();
  // A caller that never waits must not see an unhandled rejection.
  exit.catch(() => undefined);
  return {
    get pid() {
      return pid === undefined ? undefined : Number(pid.replace(/\D/gu, ""));
    },
    stderr,
    stdout,
    kill: async () => {
      if (pid !== undefined) {
        await killSandboxProcess(sandboxId, pid).catch(() => undefined);
      }
      controller.abort();
    },
    wait: async () => await exit,
  };
}

function sandboxSession(sandboxId: string): SandboxSession {
  const readBinaryFile = async (options: {
    readonly abortSignal?: AbortSignal;
    readonly path: string;
  }) =>
    await readSandboxFile(
      sandboxId,
      resolveSandboxPath(options.path),
      options.abortSignal
    );
  return {
    id: sandboxId,
    readBinaryFile,
    readFile: async (options) => {
      const bytes = await readBinaryFile(options);
      if (bytes === null) return null;
      return new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    readTextFile: async (options) => {
      const bytes = await readBinaryFile(options);
      if (bytes === null) return null;
      return sliceLines(
        decode(bytes, options.encoding),
        options.startLine,
        options.endLine
      );
    },
    removePath: async (options) => {
      await removeSandboxPath(sandboxId, {
        force: options.force,
        path: resolveSandboxPath(options.path),
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
    resolvePath: resolveSandboxPath,
    run: async (options) => {
      const process = spawnCommand(sandboxId, options);
      const [stdout, stderr, exit] = await Promise.all([
        readOutput(process.stdout),
        readOutput(process.stderr),
        process.wait(),
      ]);
      return { exitCode: exit.exitCode, stderr, stdout };
    },
    setNetworkPolicy: async (policy: SandboxNetworkPolicy) => {
      if (policy !== "deny-all") {
        throw new Error(
          "The Cloud.ru code sandbox has no network: only deny-all is supported."
        );
      }
      await setSandboxNetwork(sandboxId, policy);
    },
    spawn: async (options) =>
      await Promise.resolve(spawnCommand(sandboxId, options)),
    writeBinaryFile: async (options) => {
      await writeSandboxFile(
        sandboxId,
        resolveSandboxPath(options.path),
        options.content,
        options.abortSignal
      );
    },
    writeFile: async (options) => {
      await writeSandboxFile(
        sandboxId,
        resolveSandboxPath(options.path),
        await readAll(options.content),
        options.abortSignal
      );
    },
    writeTextFile: async (options) => {
      await writeSandboxFile(
        sandboxId,
        resolveSandboxPath(options.path),
        encode(options.content, options.encoding),
        options.abortSignal
      );
    },
  };
}

const savedStateSchema = z.object({ workspaceId: z.string().min(1) });

/** The workspace eve's reconnect state kept from an earlier `onSession`. */
function savedWorkspace(
  metadata: SandboxBackendCreateInput["existingMetadata"]
) {
  const saved = savedStateSchema.safeParse(metadata);
  return saved.success ? saved.data.workspaceId : undefined;
}

/**
 * The backend eve opens sandboxes with; its prewarm keeps nothing, since
 * the host's root file system is the template. Each `create` — every step that
 * needs the sandbox — takes up the live container or restores the saved
 * `/workspace`, and hands the host a fresh tool router token and snapshot
 * links. The workspace comes from `onSession` (`use({ workspaceId })`) and is
 * kept in eve's reconnect state for the session's later steps.
 */
export function cloudRuSandbox(): SandboxBackend<
  Record<string, never>,
  CloudRuSessionOptions
> {
  return {
    name: backendName,
    create: async (input) => {
      // Checked here, not when the backend is made: eve prewarms every
      // sandbox during the build, where the host's settings may be absent.
      if (!sandboxHostConfigured()) {
        throw new Error(
          "The code sandbox host is not configured: set SANDBOX_HOST_ID, SANDBOX_HOST_ORIGIN and SANDBOX_SIGNING_KEY."
        );
      }
      const sandboxId = sandboxIdFor(input.sessionKey);
      let workspaceId = savedWorkspace(input.existingMetadata) ?? "";
      await openSandbox(sandboxId, openRequest(sandboxId, workspaceId));
      const session = sandboxSession(sandboxId);
      const handle: SandboxBackendHandle<CloudRuSessionOptions> = {
        captureState: async () =>
          await Promise.resolve({
            backendName,
            metadata: { sandboxId, workspaceId },
            sessionKey: input.sessionKey,
          }),
        delete: async (options) => {
          await deleteSandbox(sandboxId);
          // Its saved `/workspace` goes too, or the next open restores it.
          await deleteSnapshot(sandboxId, options?.abortSignal);
        },
        session,
        shutdown: async () => {
          try {
            await settleSandbox(sandboxId, "stop");
          } catch (error) {
            console.warn("[sandbox] shutdown snapshot failed", {
              cause: error,
              sandboxId,
            });
          }
        },
        stop: async () => {
          await settleSandbox(sandboxId, "stop");
        },
        useSessionFn: async (options) => {
          if (
            options?.workspaceId !== undefined &&
            options.workspaceId !== workspaceId
          ) {
            workspaceId = options.workspaceId;
            await openSandbox(sandboxId, openRequest(sandboxId, workspaceId));
          }
          return session;
        },
      };
      return handle;
    },
    prewarm: async () => await Promise.resolve({ reused: true }),
  };
}
