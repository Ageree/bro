import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MEMO = path.join(ROOT, "vendor/optmem/memo");

export function memoryDir(tenantId: string): string {
  const safe = tenantId.replace(/[^0-9A-Za-z+._-]/g, "_");
  const agent = (process.env.INKBOX_AGENT_HANDLE ?? "bro").replace(/[^0-9A-Za-z._-]/g, "_");
  return path.join(ROOT, "data", "optmem", agent, safe);
}

function ensureStore(dir: string): void {
  if (fs.existsSync(path.join(dir, "LOG.txt"))) return;
  fs.mkdirSync(dir, { recursive: true });
  const init = spawnSync("python3", [MEMO, "init"], {
    env: { ...process.env, MEMORY_DIR: dir },
    encoding: "utf8",
    timeout: 15_000,
  });
  if (init.status !== 0) {
    throw new Error(`memo init failed: ${(init.stderr || init.stdout).trim()}`);
  }
}

export function runMemo(
  tenantId: string,
  args: string[],
): { stdout: string; stderr: string; code: number } {
  const dir = memoryDir(tenantId);
  ensureStore(dir);
  const r = spawnSync("python3", [MEMO, ...args], {
    env: { ...process.env, MEMORY_DIR: dir },
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    stdout: (r.stdout ?? "").trimEnd(),
    stderr: (r.stderr ?? "").trimEnd(),
    code: r.status ?? 1,
  };
}

export function memoText(tenantId: string, args: string[]): string {
  const { stdout, stderr, code } = runMemo(tenantId, args);
  const out = [stdout, stderr].filter(Boolean).join("\n");
  if (code !== 0 && !out) throw new Error(`memo ${args[0]} failed (${code})`);
  return out;
}
