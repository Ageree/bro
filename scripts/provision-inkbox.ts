import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Inkbox } from "@inkbox/sdk";

const envPath = resolve(import.meta.dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  const k = t.slice(0, i);
  const v = t.slice(i + 1);
  if (process.env[k] === undefined) process.env[k] = v;
}

const handle = process.env.INKBOX_AGENT_HANDLE ?? "bro-ageree";

const inkbox = new Inkbox();
let identity;
try {
  identity = await inkbox.createIdentity(handle, {
    displayName: "Bro",
    imessageEnabled: true,
  });
  console.log("created identity", identity.agentHandle, identity.emailAddress);
} catch (err) {
  console.error("create failed, trying get", err);
  identity = await inkbox.getIdentity(handle);
  if (!identity.imessageEnabled) {
    await identity.update({ imessageEnabled: true });
  }
  console.log("using identity", identity.agentHandle, identity.emailAddress);
}

const router = await inkbox.imessages.getTriageNumber();
console.log("iMessage router", router.number);
console.log("connect command", router.connectCommand);
console.log("Tell the human: text that command (blue iMessage, Wi-Fi). Send as SMS = off.");
