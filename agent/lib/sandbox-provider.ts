export type StagedFile = {
  name: string;
  bytes: Uint8Array;
};

export type SandboxRunInput = {
  files: StagedFile[];
  command: string;
  script?: string;
  timeoutMs: number;
};

export type SandboxRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: StagedFile[];
};

export type SandboxProvider = {
  run(input: SandboxRunInput): Promise<SandboxRunResult>;
};

export const SANDBOX_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
export const SANDBOX_OUTPUT_MAX_FILES = 20;
export const SANDBOX_INPUT_MAX_FILES = 20;
export const SANDBOX_TIMEOUT_MAX_MS = 240_000;
export const SANDBOX_LOG_MAX = 32 * 1024;

export function clipLog(text: string, max = SANDBOX_LOG_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated)`;
}

export function safeOutputName(raw: string): string | null {
  const base = raw.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base || base === "." || base === ".." || base.includes("..")) return null;
  return base.slice(0, 200);
}
