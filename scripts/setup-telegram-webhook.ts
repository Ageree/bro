import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTelegramWebhook } from "../agent/lib/telegram.ts";

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

function newSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

loadEnv();
if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN missing");
}
if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
  upsertEnv("TELEGRAM_WEBHOOK_SECRET", newSecret());
  console.log("telegram webhook secret stored");
}

const base =
  process.env.INKBOX_WEBHOOK_URL?.replace(/\/webhooks\/imessage\/?$/, "") ??
  process.env.BRO_PUBLIC_URL ??
  "";
if (!base) {
  throw new Error("INKBOX_WEBHOOK_URL or BRO_PUBLIC_URL needed for webhook URL");
}
const url = `${base.replace(/\/$/, "")}/webhooks/telegram`;
await setTelegramWebhook({
  url,
  secret: process.env.TELEGRAM_WEBHOOK_SECRET!,
});
console.log("telegram webhook", url);
