import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Inkbox } from "@inkbox/sdk";

const envPath = resolve(import.meta.dirname, "../.env.local");

function loadEnv() {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i);
    const v = t.slice(i + 1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function upsertEnv(key: string, value: string) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push(`${key}=${value}`);
  }
  writeFileSync(envPath, next.join("\n"));
  process.env[key] = value;
}

loadEnv();
const handle = process.env.INKBOX_AGENT_HANDLE ?? "bro-ageree";
const inkbox = new Inkbox();
const identity = await inkbox.getIdentity(handle);

if (!process.env.INKBOX_WEBHOOK_SECRET) {
  const key = await identity.createSigningKey();
  upsertEnv("INKBOX_WEBHOOK_SECRET", key.signingKey);
  console.log("signing key stored, last4", key.signingKey.slice(-4));
} else {
  console.log("signing key already in env");
}

upsertEnv("ALLOWED_SENDERS", "+79217818876");

const url =
  process.env.INKBOX_WEBHOOK_URL ??
  `https://${handle}.inkboxwire.com/webhooks/imessage`;
const existing = await inkbox.webhooks.subscriptions.list({
  agentIdentityId: identity.id,
});
const same = existing.find((s) => s.url === url);
if (same) {
  console.log("webhook exists", same.id, same.eventTypes.join(","));
} else {
  const sub = await inkbox.webhooks.subscriptions.create({
    agentIdentityId: identity.id,
    url,
    eventTypes: [
      "imessage.received",
      "imessage.delivery_failed",
      "imessage.sent",
    ],
  });
  if (sub.signingKey) {
    upsertEnv("INKBOX_WEBHOOK_SECRET", sub.signingKey);
    console.log("signing key from first subscription, last4", sub.signingKey.slice(-4));
  }
  console.log("webhook created", sub.id, url);
}

console.log("allowed sender +79217818876");
console.log("webhook url", url);
