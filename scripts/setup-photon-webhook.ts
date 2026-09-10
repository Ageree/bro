import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

function authHeader(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

loadEnv();
const projectId = process.env.SPECTRUM_PROJECT_ID?.trim();
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET?.trim();
if (!projectId || !projectSecret) {
  throw new Error("SPECTRUM_PROJECT_ID/SECRET missing");
}

const webhookUrl =
  process.env.SPECTRUM_WEBHOOK_URL?.trim() ||
  process.env.EVE_URL?.replace(/\/$/, "") + "/webhooks/photon" ||
  "";
if (!webhookUrl || !webhookUrl.startsWith("http")) {
  throw new Error("Set SPECTRUM_WEBHOOK_URL or EVE_URL to the public eve host");
}

const auth = authHeader(projectId, projectSecret);
const listRes = await fetch(
  `https://spectrum.photon.codes/projects/${projectId}/webhooks/`,
  { headers: { Authorization: auth, Accept: "application/json" } },
);
const listText = await listRes.text();
let listed: { succeed?: boolean; data?: Array<{ id?: string; webhookUrl?: string }> } = {};
try {
  listed = JSON.parse(listText) as typeof listed;
} catch {
  listed = {};
}
const same = listed.data?.find((row) => row.webhookUrl === webhookUrl);
if (same) {
  console.log("photon webhook exists", same.id, webhookUrl);
  if (!process.env.SPECTRUM_WEBHOOK_SECRET) {
    console.log("SPECTRUM_WEBHOOK_SECRET missing — rotate in Photon dashboard or re-register after delete");
  }
  process.exit(0);
}

const createRes = await fetch(
  `https://spectrum.photon.codes/projects/${projectId}/webhooks/`,
  {
    method: "POST",
    headers: {
      Authorization: auth,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      webhookUrl,
      schemaVersion: "normalized-events.v1",
      eventTypes: ["message.received"],
    }),
  },
);
const createText = await createRes.text();
let created: {
  succeed?: boolean;
  message?: string;
  data?: { id?: string; signingSecret?: string };
} = {};
try {
  created = JSON.parse(createText) as typeof created;
} catch {
  created = {};
}
if (!createRes.ok || !created.succeed || !created.data?.id) {
  throw new Error(`photon webhook ${createRes.status}: ${created.message ?? createText.slice(0, 200)}`);
}
if (created.data.signingSecret) {
  upsertEnv("SPECTRUM_WEBHOOK_SECRET", created.data.signingSecret);
  console.log("SPECTRUM_WEBHOOK_SECRET stored, last4", created.data.signingSecret.slice(-4));
}
console.log("photon webhook created", created.data.id, webhookUrl);
