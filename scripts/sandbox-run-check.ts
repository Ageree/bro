#!/usr/bin/env npx tsx
/**
 * sandbox-run-check — provider interface, network policy, harvest.
 *
 * Run: npm run sandbox-run:check
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sandboxNetworkViolation } from "../agent/lib/sandbox-policy.ts";
import {
  SANDBOX_OUTPUT_MAX_BYTES,
  SANDBOX_TIMEOUT_MAX_MS,
  clipLog,
  safeOutputName,
  type SandboxProvider,
} from "../agent/lib/sandbox-provider.ts";
import { runSandboxTask } from "../agent/lib/sandbox-run.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

assert.equal(safeOutputName("/vercel/sandbox/work/out/table.csv"), "table.csv");
assert.equal(safeOutputName("../etc/passwd"), "passwd");
assert.equal(safeOutputName(".."), null);
assert.ok(clipLog("x".repeat(40_000)).includes("truncated"), "clip long logs");
assert.equal(SANDBOX_TIMEOUT_MAX_MS, 240_000, "240s cap");
assert.equal(SANDBOX_OUTPUT_MAX_BYTES, 4 * 1024 * 1024, "4MB harvest cap");

assert.ok(
  sandboxNetworkViolation("curl https://example.com") !== null,
  "curl blocked",
);
assert.equal(
  sandboxNetworkViolation("python3 -c 'print(open(\"in/a.txt\").read())'"),
  null,
  "local python ok",
);

const vercelSrc = readFileSync(join(root, "agent/lib/sandbox-run.ts"), "utf8");
assert.match(vercelSrc, /timeout:/, "sandbox auto-stops");
assert.match(vercelSrc, /networkPolicy:\s*"deny-all"/, "deny-all network");
assert.match(vercelSrc, /sandbox\.stop/, "always stop");
assert.doesNotMatch(vercelSrc, /BOX_API_KEY/, "no box key in sandbox");

const fake: SandboxProvider = {
  async run(input) {
    assert.equal(input.files[0]?.name, "note.txt", "stages selected file");
    return {
      exitCode: 0,
      stdout: "1",
      stderr: "",
      outputs: [{ name: "out.txt", bytes: new Uint8Array([111, 107]) }],
    };
  },
};

const harvested = await fake.run({
  files: [{ name: "note.txt", bytes: new Uint8Array([104, 105]) }],
  command: "cd /vercel/sandbox/work && wc -c in/note.txt > out/out.txt",
  timeoutMs: 1000,
});
assert.equal(harvested.exitCode, 0, "fake exit");
assert.equal(harvested.outputs[0]?.name, "out.txt", "harvested output");

await assert.rejects(
  () =>
    runSandboxTask({
      phoneE164: "+79990000000",
      command: "curl https://example.com",
      provider: {
        async run() {
          throw new Error("must not create a sandbox");
        },
      },
    }),
  /Сеть из sandbox запрещена/,
  "network command denied before create",
);

const tool = readFileSync(join(root, "agent/tools/sandbox_run.ts"), "utf8");
assert.match(tool, /asPersonal/, "sandbox_run is personal-only");
assert.match(tool, /browser_task/, "points sites at browser_task");
assert.doesNotMatch(tool, /Vercel|ASCII/i, "no vendor names in the tool");

console.log("sandbox-run-check: ok");
