import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Inkbox } from "@inkbox/sdk";
import { connect } from "@inkbox/sdk/tunnels/connect";

const envPath = resolve(import.meta.dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  const k = t.slice(0, i);
  if (process.env[k] === undefined) process.env[k] = t.slice(i + 1);
}

const handle = process.env.INKBOX_AGENT_HANDLE ?? "bro-ageree";
const inkbox = new Inkbox();
const listener = await connect(inkbox, {
  name: handle,
  forwardTo: "http://127.0.0.1:2000",
  onStatus: (s) => console.log("tunnel", s),
});
console.log("forwarding", listener.publicUrl, "-> http://127.0.0.1:2000");
await listener.wait();
