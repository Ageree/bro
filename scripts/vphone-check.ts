import { createServer } from "node:net";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { assert, eq, src } from "./lib/check.ts";
import {
  appPosition,
  decodeResponse,
  discoverSocket,
  encodeCommand,
  sendCommand,
  VPHONE_KEYS,
  VPHONE_SCREEN,
} from "./lib/vphone.ts";

eq(VPHONE_SCREEN.width, 1290, "screen width");
eq(VPHONE_SCREEN.height, 2796, "screen height");
assert(VPHONE_KEYS.join(" ") === "home power volup voldown", "keys");

eq(
  encodeCommand({ t: "tap", x: 645, y: 1398 }),
  '{"t":"tap","x":645,"y":1398}\n',
  "encode tap",
);
eq(
  encodeCommand({ t: "key", name: "home", screen: false }),
  '{"t":"key","name":"home","screen":false}\n',
  "encode key",
);
eq(
  encodeCommand({ t: "type", text: "https://brobro.tech" }),
  '{"t":"type","text":"https://brobro.tech"}\n',
  "encode type",
);

const decoded = decodeResponse('{"ok":true,"image":"abc"}\n');
eq(decoded.ok, true, "decode ok");
eq(decoded.image, "abc", "decode image");
try {
  decodeResponse('{"nope":1}');
  throw new Error("decode should reject");
} catch (err) {
  assert(err instanceof Error && err.message.includes("missing ok"), "decode rejects");
}

const safari = appPosition("Safari");
assert(safari !== null, "safari dock");
eq(safari.x, 460, "safari dock x");
eq(safari.y, 2500, "safari dock y");
const messages = appPosition("messages");
assert(messages !== null, "messages dock");
eq(messages.x, 820, "messages dock x");
eq(messages.y, 2500, "messages dock y");
const settings = appPosition("Settings");
assert(settings !== null, "settings grid");
eq(settings.x, 500, "settings grid x");
eq(settings.y, 1830, "settings grid y");
assert(appPosition("bro") === null, "unknown app");

const root = join(tmpdir(), `vphone-check-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, ".vphone", "VMs", "bro"), { recursive: true });
mkdirSync(join(root, ".vphone", "VMs", "other"), { recursive: true });
writeFileSync(join(root, ".vphone", "VMs", "other", "vphone.sock"), "");
eq(
  discoverSocket({ VPHONE_SOCK: "/tmp/explicit.sock" }, root),
  "/tmp/explicit.sock",
  "explicit sock",
);
eq(
  discoverSocket({ VPHONE_VM: "missing" }, root),
  join(root, ".vphone", "VMs", "other", "vphone.sock"),
  "scan other vm",
);
writeFileSync(join(root, ".vphone", "VMs", "bro", "vphone.sock"), "");
eq(
  discoverSocket({}, root),
  join(root, ".vphone", "VMs", "bro", "vphone.sock"),
  "default bro vm",
);
rmSync(root, { recursive: true, force: true });
assert(discoverSocket({ VPHONE_SOCK: "" }, "/no/such/home") === null, "no socket");

const sockPath = join(tmpdir(), `vphone-loop-${process.pid}.sock`);
rmSync(sockPath, { force: true });
const seen: string[] = [];
const server = createServer((c) => {
  let buf = "";
  c.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    if (!buf.includes("\n")) return;
    seen.push(buf.trim());
    c.end('{"ok":true,"image":"Zm9v"}\n');
  });
});
await new Promise<void>((resolve, reject) => {
  server.on("error", reject);
  server.listen(sockPath, () => {
    chmodSync(sockPath, 0o666);
    resolve();
  });
});
try {
  const live = await sendCommand(sockPath, { t: "screenshot" });
  eq(live.ok, true, "loopback ok");
  eq(live.image, "Zm9v", "loopback image");
  eq(seen[0], '{"t":"screenshot"}', "loopback saw screenshot");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(sockPath, { force: true });
}

const setup = src("scripts/vphone-setup.sh");
assert(setup.includes("Darwin"), "setup is Darwin-gated");
assert(setup.includes("arm64"), "setup is Apple Silicon-gated");
assert(setup.includes("zqxwce/tap/vphone-cli"), "setup installs the tap");
assert(setup.includes("allow-research-guests"), "setup documents SIP");
assert(setup.includes("amfi_get_out_of_my_way"), "setup documents AMFI");
assert(setup.includes("vphone-cli vm create"), "setup documents vm create");
assert(setup.includes("iMessage"), "setup warns about iMessage");

if (process.platform !== "darwin") {
  const run = spawnSync("bash", ["scripts/vphone-setup.sh"], { encoding: "utf8" });
  eq(run.status, 2, "setup exits 2 off Mac");
  assert(
    (run.stderr + run.stdout).includes("Apple Silicon"),
    "setup explains Apple Silicon",
  );
}

const e2e = src("scripts/vphone-e2e.ts");
assert(e2e.includes("discoverSocket"), "e2e uses discoverSocket");
assert(e2e.includes("sendCommand"), "e2e uses sendCommand");
assert(e2e.includes("appPosition(\"safari\")") || e2e.includes("appPosition('safari')"), "e2e opens Safari");
assert(e2e.includes("brobro.tech"), "e2e defaults to brobro.tech");

const skill = src(".cursor/skills/vphone/SKILL.md");
assert(skill.includes("vphone-cli"), "skill names vphone-cli");
assert(skill.includes("Darwin"), "skill refuses Cloud Linux");
assert(skill.includes("vphone.sock"), "skill names the socket");
assert(skill.includes("cabinet.html"), "skill covers cabinet");
assert(skill.includes("vault.html"), "skill covers vault");
assert(skill.includes("physical iPhone"), "skill keeps physical iPhone for iMessage");
assert(skill.includes("vphone-mcp"), "skill mentions MCP");

const pkg = src("package.json");
assert(pkg.includes("vphone:check"), "npm vphone:check");
assert(pkg.includes("vphone:setup"), "npm vphone:setup");
assert(pkg.includes("vphone:e2e"), "npm vphone:e2e");

const readme = src("README.md");
assert(readme.includes("vphone:check"), "README documents vphone");
assert(readme.includes("docs/vphone.md"), "README points at docs");

const env = src(".env.example");
assert(env.includes("VPHONE_SOCK"), "env example has VPHONE_SOCK");
assert(env.includes("VPHONE_VM"), "env example has VPHONE_VM");

console.log("vphone-check ok");
