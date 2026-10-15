import { createHash, randomUUID } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import checkScript from "../../../sandbox/kit/boot/check.py?raw";
import freshScript from "../../../sandbox/kit/boot/fresh.py?raw";
import runScript from "../../../sandbox/kit/boot/run.py?raw";
import unpackScript from "../../../sandbox/kit/boot/unpack.py?raw";
// The package, one line per file here and one in `kitFiles` below. A file
// left out never reaches a sandbox: tests/agent/sandbox/kit.test.ts walks
// sandbox/kit/brokit and compares.
import brokitInit from "../../../sandbox/kit/brokit/__init__.py?raw";
import brokitMain from "../../../sandbox/kit/brokit/__main__.py?raw";
import brokitCli from "../../../sandbox/kit/brokit/cli.py?raw";
import imgInit from "../../../sandbox/kit/brokit/img/__init__.py?raw";
import brokitLook from "../../../sandbox/kit/brokit/look.py?raw";
import officeInit from "../../../sandbox/kit/brokit/office/__init__.py?raw";
import pdfInit from "../../../sandbox/kit/brokit/pdf/__init__.py?raw";
import brokitRender from "../../../sandbox/kit/brokit/render.py?raw";
import ruInit from "../../../sandbox/kit/brokit/ru/__init__.py?raw";
import brokitUtil from "../../../sandbox/kit/brokit/util.py?raw";

/**
 * The task agent's file kit `brokit` (sandbox/kit/README.md) travels with
 * Bro's release, not in the sandbox image: its Python sources are bundled
 * here as text and written into a sandbox when it lacks them.
 *
 * - A task sandbox keeps the kit at /workspace/.bro/kit (the only
 *   snapshotted directory), with the model's wrapper bin/brokit. The task
 *   agent's hook calls `ensureKit` on every message; it hashes the files on
 *   disk again, since the model can write anything under /workspace.
 * - Bro's own sandbox never runs a copy left on disk: `runFreshKit` writes
 *   the whole kit into a directory made for that one call (signing).
 *
 * Every exec is one constant command: the boot script, the arguments and
 * the paths travel in the environment, so nothing a model wrote reaches the
 * shell. `python3 -I` keeps the working directory and PYTHON* variables off
 * the import path, so a planted `json.py` in /workspace shadows nothing.
 */
const kitFiles: readonly (readonly [string, string])[] = [
  ["brokit/__init__.py", brokitInit],
  ["brokit/__main__.py", brokitMain],
  ["brokit/cli.py", brokitCli],
  ["brokit/img/__init__.py", imgInit],
  ["brokit/look.py", brokitLook],
  ["brokit/office/__init__.py", officeInit],
  ["brokit/pdf/__init__.py", pdfInit],
  ["brokit/render.py", brokitRender],
  ["brokit/ru/__init__.py", ruInit],
  ["brokit/util.py", brokitUtil],
];

/**
 * The kit's version: 16 hex of SHA-256 over its files sorted by path, each
 * as `path \0 content \0` in UTF-8. The boot scripts hash the files on
 * disk the same way (sandbox/kit/boot/check.py); a vector shared by both
 * test suites pins the formula.
 */
export const kitVersion = (() => {
  const hash = createHash("sha256");
  for (const [path, text] of kitFiles.toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    hash.update(path).update("\0").update(text).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
})();

/** What the boot scripts unpack: about 300 KB once the kit is whole. */
const manifest = JSON.stringify({ files: kitFiles, version: kitVersion });

/** Where a task sandbox keeps the kit, its wrapper, caches and mark token. */
const kitHome = "/workspace/.bro";

const kitCommand = `P=/opt/py/bin/python3; [ -x "$P" ] || P=python3; exec "$P" -I -c "import os;exec(os.environ['BROKIT_BOOT'])"`;

type KitSandbox = Pick<SandboxSession, "run" | "writeTextFile">;

/** A finished kit command: its exit code, its JSON line, its stderr. */
interface KitRun {
  readonly exitCode: number;
  readonly json: z.infer<ReturnType<typeof z.json>> | undefined;
  readonly stderr: string;
}

const bootStateSchema = z.object({
  state: z.enum(["current", "stale", "written"]),
});

/** The last non-empty line of stdout as JSON, which every kit command prints. */
function lastJsonLine(stdout: string) {
  const line = stdout
    .split("\n")
    .map((text) => text.trim())
    .findLast((text) => text.length > 0);
  if (line === undefined) return undefined;
  try {
    return z.json().parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function tail(text: string) {
  const trimmed = text.trim();
  return trimmed.length === 0 ? "no output" : trimmed.slice(-400);
}

function bootState(result: Awaited<ReturnType<KitSandbox["run"]>>) {
  const state =
    result.exitCode === 0
      ? bootStateSchema.safeParse(lastJsonLine(result.stdout)).data?.state
      : undefined;
  if (state === undefined) {
    throw new Error(`The kit was not delivered: ${tail(result.stderr)}`);
  }
  return state;
}

function within(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Makes sure a task sandbox holds this release's kit: one exec when it does
 * (about 0.1–0.3 s), else the manifest written under a name of this call's
 * own and unpacked under the kit's lock, so parallel calls are safe. The
 * hook passes the workspace's sign-mark token (`signMarkToken`), which the
 * boot script keeps in /workspace/.bro/mark-token for `pdf sign-mark`.
 */
export async function ensureKit(
  sandbox: KitSandbox,
  options: { readonly markToken?: string; readonly signal?: AbortSignal } = {}
): Promise<"current" | "written"> {
  const checkEnv = {
    BROKIT_BOOT: checkScript,
    BROKIT_EXPECT: kitVersion,
    BROKIT_HOME: kitHome,
  };
  const checked = await sandbox.run({
    abortSignal: options.signal,
    command: kitCommand,
    env:
      options.markToken === undefined
        ? checkEnv
        : { ...checkEnv, BROKIT_TOKEN: options.markToken },
  });
  if (bootState(checked) === "current") return "current";
  const manifestPath = `${kitHome}/kit-${randomUUID()}.json`;
  await sandbox.writeTextFile({
    abortSignal: options.signal,
    content: manifest,
    path: manifestPath,
  });
  const unpacked = await sandbox.run({
    abortSignal: options.signal,
    command: kitCommand,
    env: {
      BROKIT_BOOT: unpackScript,
      BROKIT_EXPECT: kitVersion,
      BROKIT_HOME: kitHome,
      BROKIT_MANIFEST: manifestPath,
    },
  });
  return bootState(unpacked) === "current" ? "current" : "written";
}

function kitRun(result: Awaited<ReturnType<KitSandbox["run"]>>): KitRun {
  return {
    exitCode: result.exitCode,
    json: lastJsonLine(result.stdout),
    stderr: result.stderr,
  };
}

/**
 * `brokit <args>` in a task sandbox. Exit 3 means the kit there is missing
 * or another release's (the hook did not run, a release came mid-turn, the
 * task agent continued after a sign-in card): it is delivered and the
 * command asked once more. Exits 0, 1 and 2 come back with their JSON.
 */
export async function runKit(
  sandbox: KitSandbox,
  args: readonly string[],
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}
): Promise<KitRun> {
  const signal = within(options.signal, options.timeoutMs ?? 150_000);
  const run = async () =>
    await sandbox.run({
      abortSignal: signal,
      command: kitCommand,
      env: {
        BROKIT_ARGS: JSON.stringify(args),
        BROKIT_BOOT: runScript,
        BROKIT_EXPECT: kitVersion,
        BROKIT_HOME: kitHome,
      },
      workingDirectory: "/workspace",
    });
  const first = await run();
  if (first.exitCode !== 3) return kitRun(first);
  await ensureKit(sandbox, { signal });
  const again = await run();
  if (again.exitCode === 3) {
    throw new Error(`The kit could not be delivered: ${tail(again.stderr)}`);
  }
  return kitRun(again);
}

/**
 * `brokit <args>` in Bro's own sandbox, from a fresh copy:
 * `dir` is a directory the caller made for this one call and deletes after
 * it (`/tmp/bro-sign-<uuid>`); the kit is written there and checked against
 * its hash before it runs, with the hostile-input limits on. A copy left in
 * /workspace is never read. A boot failure throws, so the caller tells it
 * from a refusal of the document (exit 2) or a bug (exit 1).
 */
export async function runFreshKit(
  sandbox: KitSandbox,
  dir: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}
): Promise<KitRun> {
  if (!/^\/tmp\/[\w-]+$/u.test(dir)) {
    throw new Error(
      "The kit runs fresh only in a directory of its own under /tmp."
    );
  }
  const signal = within(options.signal, options.timeoutMs ?? 60_000);
  await sandbox.writeTextFile({
    abortSignal: signal,
    content: manifest,
    path: `${dir}/kit.json`,
  });
  const result = await sandbox.run({
    abortSignal: signal,
    command: kitCommand,
    env: {
      BROKIT_ARGS: JSON.stringify(args),
      BROKIT_BOOT: freshScript,
      BROKIT_DIR: dir,
      BROKIT_EXPECT: kitVersion,
    },
    workingDirectory: dir,
  });
  if (result.exitCode === 3) {
    throw new Error(`The kit did not start: ${tail(result.stderr)}`);
  }
  return kitRun(result);
}
