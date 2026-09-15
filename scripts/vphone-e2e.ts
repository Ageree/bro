import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appPosition,
  discoverSocket,
  sendCommand,
  type VPhoneResponse,
} from "./lib/vphone.ts";

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function requireOk(resp: VPhoneResponse, step: string): VPhoneResponse {
  if (!resp.ok) fail(`${step}: ${resp.error ?? "not ok"}`);
  return resp;
}

const sock = discoverSocket();
if (!sock) {
  fail(
    [
      "No vphone.sock. This is a live iOS VM driver — it only runs on an Apple Silicon Mac with a launched VM.",
      "On the MacBook: npm run vphone:setup",
      "Then: vphone-cli vm create bro -V jb && vphone-cli vm launch bro",
      "Optional: VPHONE_SOCK=~/.vphone/VMs/bro/vphone.sock VPHONE_VM=bro",
    ].join("\n"),
  );
}

console.log(`socket ${sock}`);

const shot = requireOk(await sendCommand(sock, { t: "screenshot" }), "screenshot");
if (!shot.image) fail("screenshot returned no image");
console.log(`screenshot ok (${shot.image.length} b64)`);

requireOk(await sendCommand(sock, { t: "key", name: "home", screen: false }), "home");

const safari = appPosition("safari");
if (!safari) fail("safari dock position missing");
requireOk(await sendCommand(sock, { t: "tap", x: safari.x, y: safari.y }), "open safari");

const site = process.env.VPHONE_SITE ?? "https://brobro.tech";
requireOk(await sendCommand(sock, { t: "type", text: site, screen: false }), "clipboard site");

const after = requireOk(await sendCommand(sock, { t: "screenshot" }), "after");
if (after.image) {
  const out = join(tmpdir(), "vphone-e2e.jpg");
  writeFileSync(out, Buffer.from(after.image, "base64"));
  console.log(`saved ${out}`);
}

console.log(`vphone-e2e ok (${site} on clipboard; tap Safari URL bar + paste on the VM)`);
