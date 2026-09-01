import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const { composio } = await import("../agent/lib/composio.ts");

const webhookUrl = process.argv[2] ?? process.env.COMPOSIO_WEBHOOK_URL;
if (!webhookUrl) {
  console.error(
    "usage: npm run composio:webhook -- https://<deployment>.convex.site/composio",
  );
  process.exit(1);
}

const sub = await composio().triggers.setWebhookSubscription({ webhookUrl });

console.log("webhook url", sub.webhookUrl);
console.log("subscription id", sub.id, "version", sub.version);
if (sub.secret) {
  // Printed once for the operator; the Convex deployment verifies signatures with it.
  console.log(`npx convex env set COMPOSIO_WEBHOOK_SECRET ${sub.secret}`);
} else {
  console.log("secret not returned: reuse the existing COMPOSIO_WEBHOOK_SECRET");
}
