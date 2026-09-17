// Is Telegram actually working? One command, one verdict.
//
//   npm run telegram:health                      # ask the production deployment
//   npm run telegram:health -- --base=https://…  # ask another deployment
//   npm run telegram:health -- --repair          # and re-point a drifted webhook
//   npm run telegram:health -- --local           # ask Telegram directly, from .env.local
//
// Why this is not a `*:check`: every way Telegram dies in production is
// invisible offline. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and
// `TELEGRAM_WEBHOOK_SECRET` live on the deployment, and the webhook URL lives
// at Telegram — set once by hand, so it keeps pointing at whatever host was
// live that day. A missing username tells every person who asks that the
// channel is off; a missing webhook secret makes the bot deaf behind a 401
// nobody reads; a stale URL sends every message in Telegram to another host.
// None of that is a code bug, so no unit check can ever see it.
//
// Remote mode reads the deployment's own answer (`/internal/telegram-health`,
// secret-gated) — that is the only place the variables exist. Local mode needs
// `TELEGRAM_BOT_TOKEN` in `.env.local` and answers the Telegram half only.
//
// Exit codes, so `deploy.sh` can tell the three apart: 0 the chain works,
// 1 it is broken, 2 the check itself could not run, 3 no Telegram is
// configured here at all — a deployment's choice, not a fault.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  telegramHealth,
  type TelegramHealth,
  type TelegramHealthFacts,
} from "../convex/lib/telegramPolicy.ts";

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function loadEnvLocal(): void {
  const envPath = resolve(import.meta.dirname, "../.env.local");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const key = t.slice(0, i);
    if (process.env[key] === undefined) process.env[key] = t.slice(i + 1);
  }
}

type Report = TelegramHealth & { repaired?: boolean; facts?: TelegramHealthFacts };

function print(report: Report, where: string): void {
  const facts = report.facts;
  console.log(`telegram health (${where})`);
  if (facts) {
    console.log(`  origin            ${facts.origin}`);
    console.log(`  bot token         ${facts.hasToken ? "set" : "MISSING"}`);
    console.log(
      `  bot username      ${facts.configuredUsername ? `@${facts.configuredUsername}` : "MISSING"}` +
        (facts.botUsername ? ` (token belongs to @${facts.botUsername})` : ""),
    );
    console.log(
      `  webhook secret    ${
        facts.hasWebhookSecret
          ? "set"
          : facts.webhookSecretVisible === false
            ? "not visible from here (it lives on the deployment)"
            : "MISSING"
      }`,
    );
    console.log(`  webhook url       ${facts.webhookUrl || "(none)"}`);
    console.log(`  expected url      ${report.expectedWebhookUrl}`);
    if (facts.pendingUpdates !== undefined) {
      console.log(`  pending updates   ${facts.pendingUpdates}`);
    }
    if (facts.lastErrorMessage) {
      console.log(`  telegram's last error  ${facts.lastErrorMessage}`);
    }
  }
  if (report.repaired) console.log("  webhook re-pointed at this deployment");
  if (report.ok) {
    console.log("ok — the whole chain works: link, inbound, outbound");
    return;
  }
  for (const problem of report.problems) console.error(`  ✗ ${problem}`);
  if (report.webhookDrifted) {
    console.error("  fix: re-run with --repair, or `npm run telegram:webhooks`");
  }
}

async function remote(base: string, repair: boolean): Promise<Report> {
  const secret = process.env.BRO_INTERNAL_SECRET?.trim();
  if (!secret) throw new Error("BRO_INTERNAL_SECRET needed to ask a deployment");
  const response = await fetch(`${base.replace(/\/+$/, "")}/internal/telegram-health`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, repair }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${base} answered ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  // An unknown path on this host answers 200 with the landing page, not 404,
  // so "route not deployed" has to be read off the body type.
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("json")) {
    throw new Error(
      `${base} does not serve /internal/telegram-health yet — deploy this branch first (npm run deploy), or pass --local`,
    );
  }
  return JSON.parse(body) as Report;
}

/** Telegram's half, read from this machine. Says nothing about the deployment's
 *  own env — that is what remote mode is for. */
async function local(repair: boolean): Promise<Report> {
  loadEnvLocal();
  const { telegramGetMe, telegramWebhookInfo, setTelegramWebhook, telegramWebhookSecret } =
    await import("../agent/lib/telegram.ts");
  const origin =
    flag("origin") ??
    process.env.INKBOX_WEBHOOK_URL?.replace(/\/webhooks\/imessage\/?$/, "") ??
    process.env.BRO_PUBLIC_URL ??
    "https://bro-agent.vercel.app";
  const facts: TelegramHealthFacts = {
    origin,
    hasToken: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    configuredUsername: (process.env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, ""),
    hasWebhookSecret: Boolean(telegramWebhookSecret()),
    // A machine without the secret says nothing about the deployment that has
    // it, so local mode must not report one as broken.
    webhookSecretVisible: Boolean(telegramWebhookSecret()),
  };
  if (facts.hasToken) {
    const me = await telegramGetMe().catch((err: unknown) => ({ error: String(err) }));
    if ("error" in me) facts.tokenError = me.error;
    else if (me.username) facts.botUsername = me.username;
    const hook = await telegramWebhookInfo().catch((err: unknown) => ({ error: String(err) }));
    if ("error" in hook) {
      facts.webhookError = hook.error;
    } else {
      facts.webhookUrl = hook.url ?? "";
      facts.pendingUpdates = hook.pending_update_count ?? 0;
      if (hook.last_error_message) facts.lastErrorMessage = hook.last_error_message;
    }
  }
  let health = telegramHealth(facts);
  let repaired = false;
  const secret = telegramWebhookSecret();
  if (repair && health.webhookDrifted && secret) {
    await setTelegramWebhook({ url: health.expectedWebhookUrl, secret });
    repaired = true;
    facts.webhookUrl = health.expectedWebhookUrl;
    facts.pendingUpdates = 0;
    delete facts.lastErrorMessage;
    health = telegramHealth(facts);
  }
  return { ...health, repaired, facts };
}

const repair = has("repair");
const base = flag("base") ?? process.env.BRO_E2E_BASE ?? "https://bro-agent.vercel.app";
const useLocal = has("local");

let report: Report;
try {
  report = useLocal ? await local(repair) : await remote(base, repair);
} catch (err) {
  console.error(`telegram health could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}

print(report, useLocal ? "telegram api, from this machine" : base);
if (report.off) {
  console.error("telegram is not configured here — set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME");
  process.exit(3);
}
process.exit(report.ok ? 0 : 1);
