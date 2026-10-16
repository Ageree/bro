import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ensureKit,
  kitVersion,
  runFreshKit,
  runKit,
} from "@agent/lib/sandbox/kit";

/** The kit's hash as sandbox/kit/tests/test_boot.py pins it too. */
function contentHash(files: readonly (readonly [string, string])[]) {
  const hash = createHash("sha256");
  for (const [path, text] of files.toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    hash.update(`${path}\0${text}\0`);
  }
  return hash.digest("hex").slice(0, 16);
}

/** Every .py of the package on disk, as `brokit/…` paths. */
function packageOnDisk(directory = "sandbox/kit/brokit"): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__pycache__" ? [] : packageOnDisk(path);
    }
    return entry.name.endsWith(".py")
      ? [`brokit/${relative("sandbox/kit/brokit", path)}`]
      : [];
  });
}

const manifestSchema = z.object({
  files: z.array(z.tuple([z.string(), z.string()])),
  version: z.string(),
});

type Run = (options: {
  readonly command: string;
  readonly env?: Record<string, string>;
}) => Promise<{ exitCode: number; stderr: string; stdout: string }>;

/** Which boot script a run carries, by the variables only it gets. */
function scriptOf(env: Record<string, string> = {}) {
  if (env.BROKIT_MANIFEST !== undefined) return "unpack";
  if (env.BROKIT_DIR !== undefined) return "fresh";
  if (env.BROKIT_ARGS !== undefined) return "run";
  return "check";
}

/** A task sandbox whose kit is `state` until a manifest is unpacked. */
function sandboxWith(
  state: "current" | "stale",
  answers: Partial<
    Record<string, { exitCode: number; stderr?: string; stdout?: string }[]>
  > = {}
) {
  const written = new Map<string, string>();
  const runs: {
    readonly command: string;
    readonly env: Record<string, string>;
  }[] = [];
  let current = state === "current";
  const run = vi.fn<Run>(async ({ command, env = {} }) => {
    runs.push({ command, env });
    const script = scriptOf(env);
    const scripted = answers[script]?.shift();
    if (scripted !== undefined) {
      return Promise.resolve({ stderr: "", stdout: "", ...scripted });
    }
    if (script === "check") {
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: `${JSON.stringify({ state: current ? "current" : "stale" })}\n`,
      });
    }
    if (script === "unpack") {
      const unpacked = current ? "current" : "written";
      current = true;
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: `${JSON.stringify({ state: unpacked })}\n`,
      });
    }
    return Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: '{"ok":true,"items":[]}\n',
    });
  });
  const writeTextFile = vi.fn<
    (options: { content: string; path: string }) => Promise<void>
  >(async ({ content, path }) => {
    written.set(path, content);
    return Promise.resolve();
  });
  return { run, runs, writeTextFile, written };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the kit's delivery into a task sandbox", () => {
  it("only checks a sandbox whose kit is this release's", async () => {
    const sandbox = sandboxWith("current");

    expect(await ensureKit(sandbox, { markToken: "ab".repeat(16) })).toBe(
      "current"
    );
    expect(sandbox.run).toHaveBeenCalledOnce();
    expect(sandbox.writeTextFile).not.toHaveBeenCalled();
    expect(sandbox.runs[0]?.env).toMatchObject({
      BROKIT_EXPECT: kitVersion,
      BROKIT_HOME: "/workspace/.bro",
      BROKIT_TOKEN: "ab".repeat(16),
    });
  });

  it("writes every file of the package to a stale sandbox, hashed as the boot scripts hash it", async () => {
    const sandbox = sandboxWith("stale");

    expect(await ensureKit(sandbox)).toBe("written");
    const [[path, text] = []] = [...sandbox.written];
    expect(path).toMatch(/^\/workspace\/\.bro\/kit-[\w-]+\.json$/u);
    expect(sandbox.runs.map((run) => scriptOf(run.env))).toEqual([
      "check",
      "unpack",
    ]);
    expect(sandbox.runs[1]?.env.BROKIT_MANIFEST).toBe(path);
    const manifest = manifestSchema.parse(JSON.parse(text ?? ""));
    // A file under sandbox/kit/brokit without its `?raw` import never ships.
    expect(manifest.files.map(([file]) => file).toSorted()).toEqual(
      packageOnDisk().toSorted()
    );
    for (const [file, content] of manifest.files) {
      expect(content).toBe(readFileSync(join("sandbox/kit", file), "utf8"));
    }
    expect(manifest.version).toBe(kitVersion);
    expect(contentHash(manifest.files)).toBe(kitVersion);
    expect(
      contentHash([
        ["brokit/sub/b.py", "ПРИВЕТ = 1\n"],
        ["brokit/a.py", 'print("a")\n'],
      ])
    ).toBe("134c8acff1cb4f27");
  });

  it("gives parallel deliveries manifests of their own", async () => {
    const sandbox = sandboxWith("stale", {
      check: [
        { exitCode: 0, stdout: '{"state":"stale"}' },
        { exitCode: 0, stdout: '{"state":"stale"}' },
      ],
    });

    const results = await Promise.all([ensureKit(sandbox), ensureKit(sandbox)]);

    expect(results.toSorted()).toEqual(["current", "written"]);
    expect(new Set(sandbox.written.keys()).size).toBe(2);
  });

  it("fails with the boot script's reason", async () => {
    const sandbox = sandboxWith("stale", {
      unpack: [{ exitCode: 1, stderr: "unpack: the kit lock stayed busy" }],
    });

    await expect(ensureKit(sandbox)).rejects.toThrow(
      "the kit lock stayed busy"
    );
  });
});

describe("a kit command in a task sandbox", () => {
  it("delivers a missing kit and asks once more", async () => {
    const sandbox = sandboxWith("stale", {
      run: [{ exitCode: 3, stderr: "brokit: the kit is stale" }],
    });

    const result = await runKit(sandbox, ["look", "/workspace/a.pdf"]);

    expect(result).toEqual({
      exitCode: 0,
      json: { items: [], ok: true },
      stderr: "",
    });
    expect(sandbox.runs.map((run) => scriptOf(run.env))).toEqual([
      "run",
      "check",
      "unpack",
      "run",
    ]);
  });

  it("returns a refusal with its JSON", async () => {
    const sandbox = sandboxWith("current", {
      run: [
        {
          exitCode: 2,
          stderr: "brokit: no such file",
          stdout: '{"ok":false,"code":"not_found","error":"no such file"}\n',
        },
      ],
    });

    expect(await runKit(sandbox, ["look", "/workspace/x.pdf"])).toMatchObject({
      exitCode: 2,
      json: { code: "not_found" },
    });
  });
});

describe("a kit command from a fresh copy in Bro's sandbox", () => {
  it("writes the kit and runs it once, the arguments never in the command", async () => {
    const sandbox = sandboxWith("current");
    const hostile = "'; rm -rf / #";

    await runFreshKit(sandbox, "/tmp/bro-sign-1", [
      "pdf",
      "sign-places",
      hostile,
    ]);

    expect([...sandbox.written.keys()]).toEqual(["/tmp/bro-sign-1/kit.json"]);
    expect(sandbox.runs).toHaveLength(1);
    const [only] = sandbox.runs;
    expect(only?.command).not.toContain("rm -rf");
    expect(only?.command).toBe(
      `P=/opt/py/bin/python3; [ -x "$P" ] || P=python3; exec "$P" -I -c "import os;exec(os.environ['BROKIT_BOOT'])"`
    );
    expect(JSON.parse(only?.env.BROKIT_ARGS ?? "")).toEqual([
      "pdf",
      "sign-places",
      hostile,
    ]);
    expect(only?.env).toMatchObject({
      BROKIT_DIR: "/tmp/bro-sign-1",
      BROKIT_EXPECT: kitVersion,
    });
  });

  it("throws on a boot failure rather than reading it as the document's refusal", async () => {
    const sandbox = sandboxWith("current", {
      fresh: [{ exitCode: 3, stderr: "brokit boot: kit already exists" }],
    });

    await expect(
      runFreshKit(sandbox, "/tmp/bro-sign-2", ["pdf", "sign-places", "a.pdf"])
    ).rejects.toThrow("kit already exists");
  });

  it("refuses a directory that is not one of its own under /tmp", async () => {
    const sandbox = sandboxWith("current");

    await expect(
      runFreshKit(sandbox, "/workspace/.bro", ["pdf", "info", "a.pdf"])
    ).rejects.toThrow("under /tmp");
    expect(sandbox.run).not.toHaveBeenCalled();
  });
});
