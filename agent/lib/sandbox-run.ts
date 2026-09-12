import { posix as posixPath } from "node:path";
import { sandboxNetworkViolation } from "./sandbox-policy.ts";
import {
  FileError,
  FILE_BINARY_MAX,
  getStoredFile,
  uploadFileBytes,
} from "./files.ts";
import {
  SANDBOX_INPUT_MAX_FILES,
  SANDBOX_TIMEOUT_MAX_MS,
  type SandboxProvider,
  type StagedFile,
} from "./sandbox-provider.ts";
import { vercelSandboxProvider } from "./sandbox-vercel.ts";

export const WORKDIR = "/vercel/sandbox/work";

export type SandboxToolOk = {
  status: "ok";
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: Array<{ id: string; name: string; mimeType: string; size: number }>;
};

function defaultProvider(): SandboxProvider {
  return vercelSandboxProvider();
}

function clampTimeout(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined) return 60_000;
  return Math.min(
    Math.max(1, Math.floor(timeoutSeconds)) * 1000,
    SANDBOX_TIMEOUT_MAX_MS,
  );
}

function guessMime(name: string): string {
  const ext = posixPath.extname(name).toLowerCase();
  if (ext === ".txt" || ext === ".md") return "text/plain; charset=utf-8";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".html") return "text/html";
  return "application/octet-stream";
}

export async function runSandboxTask(opts: {
  phoneE164: string;
  fileIds?: string[];
  names?: string[];
  command?: string;
  script?: string;
  timeoutSeconds?: number;
  provider?: SandboxProvider;
}): Promise<SandboxToolOk> {
  const command = opts.command?.trim() ?? "";
  const script = opts.script?.trim() ?? "";
  if (script && command) {
    throw new FileError("invalid", "pass command or script, not both");
  }
  if (!script && !command) {
    throw new FileError("invalid", "command or script required");
  }
  const blocked = sandboxNetworkViolation(script || command);
  if (blocked) throw new FileError("denied", blocked);
  const timeoutMs = clampTimeout(opts.timeoutSeconds);

  const refs: Array<{ fileId?: string; name?: string }> = [];
  for (const fileId of opts.fileIds ?? []) {
    if (fileId.trim()) refs.push({ fileId: fileId.trim() });
  }
  for (const name of opts.names ?? []) {
    if (name.trim()) refs.push({ name: name.trim() });
  }
  if (refs.length > SANDBOX_INPUT_MAX_FILES) {
    throw new FileError("invalid", "too many input files");
  }

  const staged: StagedFile[] = [];
  for (const ref of refs) {
    const meta = await getStoredFile(opts.phoneE164, ref);
    if (!meta) {
      throw new FileError("invalid", `file not found: ${ref.fileId ?? ref.name}`);
    }
    if (!meta.url) throw new FileError("error", `file has no url: ${meta.name}`);
    if (meta.size > FILE_BINARY_MAX) {
      throw new FileError("invalid", `file exceeds 8MB: ${meta.name}`);
    }
    const res = await fetch(meta.url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new FileError("error", `could not stage ${meta.name}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    staged.push({ name: meta.name, bytes });
  }

  const wrapped = script
    ? undefined
    : `cd ${WORKDIR} && ${command}`;
  const provider = opts.provider ?? defaultProvider();
  const result = await provider.run({
    files: staged,
    command: wrapped ?? `cd ${WORKDIR} && ./run.sh`,
    ...(script ? { script } : {}),
    timeoutMs,
  });
  const outputs: SandboxToolOk["outputs"] = [];
  for (const out of result.outputs) {
    const saved = await uploadFileBytes(opts.phoneE164, {
      name: out.name,
      mimeType: guessMime(out.name),
      bytes: out.bytes,
      sourceChannel: "sandbox",
    });
    outputs.push({
      id: saved.id,
      name: saved.name,
      mimeType: saved.mimeType,
      size: saved.size,
    });
  }
  return {
    status: "ok",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs,
  };
}
