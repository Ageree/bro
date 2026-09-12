import {
  clipLog,
  safeOutputName,
  SANDBOX_OUTPUT_MAX_BYTES,
  SANDBOX_OUTPUT_MAX_FILES,
  type SandboxProvider,
  type SandboxRunInput,
  type SandboxRunResult,
} from "./sandbox-provider.ts";

const WORK = "/vercel/sandbox/work";

function credentials(): {
  token?: string;
  teamId?: string;
  projectId?: string;
} {
  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  return {
    ...(token ? { token } : {}),
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

async function streamToBuffer(
  stream: NodeJS.ReadableStream | null,
): Promise<Uint8Array | null> {
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function vercelSandboxProvider(): SandboxProvider {
  return {
    async run(input: SandboxRunInput): Promise<SandboxRunResult> {
      const { Sandbox } = await import("@vercel/sandbox");
      const sandbox = await Sandbox.create({
        ...credentials(),
        runtime: "node24",
        networkPolicy: "deny-all",
        timeout: Math.min(input.timeoutMs + 30_000, 270_000),
      });
      try {
        await sandbox.runCommand("mkdir", ["-p", `${WORK}/in`, `${WORK}/out`]);
        const staged = input.files.map((file) => ({
          path: `${WORK}/in/${file.name}`,
          content: file.bytes,
        }));
        if (input.script) {
          staged.push({
            path: `${WORK}/run.sh`,
            content: Buffer.from(input.script, "utf8"),
          });
        }
        if (staged.length > 0) {
          await sandbox.writeFiles(staged);
        }
        const command = input.script
          ? `cd ${WORK} && chmod +x run.sh && ./run.sh`
          : input.command;
        const finished = await sandbox.runCommand({
          cmd: "bash",
          args: ["-lc", command],
          cwd: WORK,
          signal: AbortSignal.timeout(input.timeoutMs),
        });
        const stdout = clipLog(await finished.stdout());
        const stderr = clipLog(await finished.stderr());
        const listed = await sandbox.runCommand("bash", [
          "-lc",
          `find ${WORK}/out -type f | head -n ${SANDBOX_OUTPUT_MAX_FILES + 5}`,
        ]);
        const paths = (await listed.stdout())
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith(`${WORK}/out/`));
        const outputs: SandboxRunResult["outputs"] = [];
        for (const path of paths) {
          if (outputs.length >= SANDBOX_OUTPUT_MAX_FILES) break;
          const name = safeOutputName(path);
          if (!name) continue;
          const buf =
            (await sandbox.readFileToBuffer({ path })) ??
            (await streamToBuffer(await sandbox.readFile({ path })));
          if (!buf || buf.byteLength === 0) continue;
          if (buf.byteLength > SANDBOX_OUTPUT_MAX_BYTES) continue;
          outputs.push({ name, bytes: buf });
        }
        return {
          exitCode: finished.exitCode,
          stdout,
          stderr,
          outputs,
        };
      } finally {
        try {
          await sandbox.stop({ blocking: true });
        } catch {
          // already gone
        }
      }
    },
  };
}
