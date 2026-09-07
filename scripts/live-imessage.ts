/** Drive Bro over real iMessage. The tester identity (dedicated line)
 *  plays the human; Bro is another Inkbox identity. Shared pool cannot
 *  start — provision claims the line. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Inkbox, type AgentIdentity, type IMessage } from "@inkbox/sdk";
import {
  allowlistWithTester,
  broHandleFromEnv,
  bubblesText,
  classifyLane,
  connectCommandFor,
  DEDICATED_UPGRADE_URL,
  DEFAULT_BRO_HANDLE,
  expectMatches,
  inboundText,
  isDedicatedQuotaError,
  isE164,
  parseE164,
  parsePlay,
  quietSettled,
  testerHandleFromEnv,
  type LiveBubble,
  type LiveLaneStatus,
  type LivePlay,
} from "../agent/lib/live-imessage.ts";
import {
  dedicatedLineFromIdentityPayload,
  existingIdentityUpdateOptions,
  sdkCreateIdentityOptions,
} from "../convex/lib/dedicatedLinePolicy.ts";

function loadDotenv(): void {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function remapPlanError(handle: string, op: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (isDedicatedQuotaError(err)) {
    return new Error(
      `no dedicated iMessage line on this plan. Upgrade (${DEDICATED_UPGRADE_URL}) then re-run provision.`,
    );
  }
  if (/identit(?:y|ies).*(?:cap|limit|quota)|402/i.test(msg)) {
    return new Error(
      `identity cap blocked ${op} ${handle}: ${msg.slice(0, 240)}`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

function inkbox(): Inkbox {
  if (!process.env.INKBOX_API_KEY) {
    throw new Error("INKBOX_API_KEY missing");
  }
  return new Inkbox();
}

async function getIdentityOrNull(
  client: Inkbox,
  handle: string,
): Promise<AgentIdentity | null> {
  try {
    return await client.getIdentity(handle);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b404\b/.test(msg) || /not found/i.test(msg)) return null;
    throw err;
  }
}

function testerNumberOf(identity: AgentIdentity): string | undefined {
  const line = dedicatedLineFromIdentityPayload(identity);
  const n = line?.number ?? identity.imessageNumber?.number;
  return isE164(n) ? n : undefined;
}

function asBubble(msg: IMessage): LiveBubble {
  const media = (msg.media ?? [])
    .map((m) => m.url)
    .filter((u): u is string => typeof u === "string" && u.length > 0)
    .join(" ");
  return {
    id: msg.id,
    direction: msg.direction === "inbound" ? "inbound" : "outbound",
    text: inboundText({ content: msg.content, media: msg.media }),
    media: media || undefined,
    service: String(msg.service ?? ""),
    wasDowngraded: msg.wasDowngraded,
    at: msg.createdAt instanceof Date ? msg.createdAt.getTime() : Date.now(),
  };
}

async function laneStatus(client: Inkbox): Promise<LiveLaneStatus> {
  const testerHandle = testerHandleFromEnv();
  const broHandle = broHandleFromEnv();
  let routerNumber: string | undefined;
  try {
    const triage = await client.imessages.getTriageNumber();
    routerNumber = triage.number;
  } catch (err) {
    console.error("triage failed", err instanceof Error ? err.message : err);
  }
  const tester = await getIdentityOrNull(client, testerHandle);
  return classifyLane({
    apiKey: process.env.INKBOX_API_KEY,
    testerExists: Boolean(tester),
    testerNumber: tester ? testerNumberOf(tester) : undefined,
    testerHandle,
    broHandle,
    routerNumber,
  });
}

async function ensureIdentity(
  client: Inkbox,
  handle: string,
  opts: { dedicated: boolean; displayName: string },
): Promise<AgentIdentity> {
  let identity = await getIdentityOrNull(client, handle);
  if (!identity) {
    try {
      identity = await client.createIdentity(
        handle,
        sdkCreateIdentityOptions(opts.dedicated, opts.displayName),
      );
      console.log("created identity", handle, identity.emailAddress ?? "");
    } catch (err) {
      throw remapPlanError(handle, "create", err);
    }
  } else {
    console.log("using identity", handle, identity.emailAddress ?? "");
  }
  const patch = existingIdentityUpdateOptions({
    dedicatedLine: opts.dedicated,
    imessageEnabled: identity.imessageEnabled,
    hasDedicatedNumber: identity.imessageNumber != null,
    handle,
  });
  if (patch) {
    try {
      await identity.update(patch);
      await identity.refresh();
    } catch (err) {
      throw remapPlanError(handle, "update", err);
    }
  }
  return identity;
}

async function provision(opts: { qa: boolean }): Promise<void> {
  const client = inkbox();
  const testerHandle = testerHandleFromEnv();
  const broHandle = opts.qa ? broHandleFromEnv() : DEFAULT_BRO_HANDLE;
  const tester = await ensureIdentity(client, testerHandle, {
    dedicated: true,
    displayName: "Bro live tester",
  });
  const number = testerNumberOf(tester);
  if (!number) {
    throw new Error(
      `${testerHandle} has no dedicated number. ${DEDICATED_UPGRADE_URL}`,
    );
  }
  console.log("tester line", number);
  if (opts.qa) {
    const bro = await ensureIdentity(client, broHandle, {
      dedicated: false,
      displayName: "Bro live",
    });
    const url = `https://${broHandle}.inkboxwire.com/webhooks/imessage`;
    const existing = await client.webhooks.subscriptions.list({
      agentIdentityId: bro.id,
    });
    const same = existing.find((s) => s.url === url);
    if (same) {
      console.log("qa webhook exists", same.id);
    } else {
      const sub = await client.webhooks.subscriptions.create({
        agentIdentityId: bro.id,
        url,
        eventTypes: [
          "imessage.received",
          "imessage.delivery_failed",
          "imessage.sent",
        ],
      });
      console.log("qa webhook created", sub.id, url);
      if (sub.signingKey) {
        console.log("qa signing key last4", sub.signingKey.slice(-4));
        console.log("set INKBOX_WEBHOOK_SECRET to that key on the eve process");
      }
    }
  }
  const triage = await client.imessages.getTriageNumber();
  console.log("router", triage.number);
  console.log("connect", connectCommandFor(broHandle));
  console.log(
    "ALLOWED_SENDERS",
    allowlistWithTester(process.env.ALLOWED_SENDERS, number),
  );
  console.log("INKBOX_AGENT_HANDLE", broHandle);
}

async function findConvo(
  tester: AgentIdentity,
  remote: string,
): Promise<string | undefined> {
  const convos = await tester.listIMessageConversations({ limit: 50 });
  return convos.find((c) => c.remoteNumber === remote)?.id;
}

export type LiveTurnResult = {
  ok: boolean;
  conversationId: string;
  sentId: string;
  downgraded: boolean;
  bubbles: LiveBubble[];
  timedOut: boolean;
};

async function liveTurn(opts: {
  text: string;
  broHandle: string;
  timeoutMs: number;
  forceConnect?: boolean;
}): Promise<LiveTurnResult> {
  const client = inkbox();
  const status = await laneStatus(client);
  if (!status.ready) {
    throw new Error(status.detail ?? status.blocker ?? "live lane not ready");
  }
  const tester = await client.getIdentity(status.testerHandle);
  const target = parseE164(process.env.BRO_LIVE_TARGET) ?? status.routerNumber;
  if (!target) throw new Error("no router / BRO_LIVE_TARGET");
  let conversationId = await findConvo(tester, target);
  if (opts.forceConnect || !conversationId) {
    const connect = connectCommandFor(opts.broHandle);
    console.log("connect", connect, "->", target);
    const opened = await tester.sendIMessage({ to: target, text: connect });
    conversationId = opened.conversationId;
    await waitForInbound(tester, conversationId, new Set([opened.id]), 45_000);
  }
  if (!conversationId) throw new Error("no conversation after connect");

  const seen = new Set(
    (await tester.listIMessages({ conversationId, limit: 80 })).map((m) => m.id),
  );
  const sent = await tester.sendIMessage({ conversationId, text: opts.text });
  seen.add(sent.id);
  const inbound = await waitForInbound(
    tester,
    conversationId,
    seen,
    opts.timeoutMs,
  );
  const ours = (await tester.listIMessages({ conversationId, limit: 20 })).find(
    (m) => m.id === sent.id,
  );
  const downgraded = Boolean(ours?.wasDowngraded);
  if (downgraded) {
    throw new Error("send was downgraded off iMessage");
  }
  return {
    ok: inbound.length > 0,
    conversationId,
    sentId: sent.id,
    downgraded,
    bubbles: inbound,
    timedOut: inbound.length === 0,
  };
}

async function waitForInbound(
  tester: AgentIdentity,
  conversationId: string,
  seen: Set<string>,
  timeoutMs: number,
): Promise<LiveBubble[]> {
  const deadline = Date.now() + timeoutMs;
  const inbound: LiveBubble[] = [];
  let lastInboundAt: number | undefined;
  while (Date.now() < deadline) {
    const msgs = await tester.listIMessages({ conversationId, limit: 80 });
    for (const msg of msgs) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      if (msg.direction !== "inbound") continue;
      const bubble = asBubble(msg);
      inbound.push(bubble);
      lastInboundAt = Date.now();
    }
    if (
      quietSettled({
        lastInboundAt,
        now: Date.now(),
        quietMs: 8_000,
      })
    ) {
      return inbound;
    }
    await sleep(2_000);
  }
  return inbound;
}

async function runPlay(play: LivePlay): Promise<void> {
  const broHandle = play.broHandle ?? broHandleFromEnv();
  console.log(`play ${play.name} -> ${broHandle}`);
  for (const [i, turn] of play.turns.entries()) {
    const result = await liveTurn({
      text: turn.text,
      broHandle,
      timeoutMs: play.timeoutMs ?? 90_000,
      forceConnect: turn.connect === true && i === 0,
    });
    const text = bubblesText(result.bubbles);
    console.log(`\n#${i + 1} you: ${turn.text}`);
    console.log(`#${i + 1} bro: ${text || "(empty)"}`);
    if (result.timedOut) throw new Error(`turn ${i + 1} timed out`);
    if (turn.expect && !expectMatches(text, turn.expect)) {
      throw new Error(`turn ${i + 1} expected /${turn.expect}/ in:\n${text}`);
    }
  }
  console.log(`\nplay ${play.name} ok`);
}

async function printStatus(): Promise<void> {
  const client = inkbox();
  const status = await laneStatus(client);
  console.log(
    JSON.stringify(
      {
        ready: status.ready,
        blocker: status.blocker,
        detail: status.detail,
        testerHandle: status.testerHandle,
        broHandle: status.broHandle,
        testerNumber: status.testerNumber ?? null,
        routerNumber: status.routerNumber ?? null,
        connectCommand: status.connectCommand,
      },
      null,
      2,
    ),
  );
  if (!status.ready) process.exitCode = 2;
}

function usage(): never {
  console.error(`Usage:
  npm run live -- status
  npm run live -- provision [--qa]
  npm run live -- "<text>"
  npm run live -- --bro bro-live-bro -- "<text>"
  npm run live -- --play .harness/plays/live-help.json`);
  process.exit(2);
}

async function main(): Promise<void> {
  loadDotenv();
  const argv = process.argv.slice(2);
  let bro = broHandleFromEnv();
  let playPath: string | undefined;
  let provisionCmd = false;
  let qa = false;
  const textParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      textParts.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "status") {
      await printStatus();
      return;
    }
    if (arg === "provision") {
      provisionCmd = true;
      continue;
    }
    if (arg === "--qa") {
      qa = true;
      continue;
    }
    if (arg === "--bro") {
      const next = argv[++i];
      if (!next) usage();
      bro = next;
      process.env.BRO_LIVE_BRO_HANDLE = next;
      continue;
    }
    if (arg === "--play") {
      playPath = argv[++i];
      continue;
    }
    if (arg === "--tester") {
      const next = argv[++i];
      if (!next) usage();
      process.env.BRO_LIVE_TESTER_HANDLE = next;
      continue;
    }
    if (arg?.startsWith("-")) usage();
    if (arg) textParts.push(arg);
  }

  if (provisionCmd) {
    await provision({ qa });
    return;
  }
  if (playPath) {
    const play = parsePlay(JSON.parse(readFileSync(resolve(playPath), "utf8")));
    await runPlay(play);
    return;
  }
  const text = textParts.join(" ").trim();
  if (!text) usage();
  const result = await liveTurn({
    text,
    broHandle: bro,
    timeoutMs: 90_000,
  });
  console.log(bubblesText(result.bubbles) || "(empty)");
  if (result.timedOut) process.exit(1);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("live-imessage.ts") || entry.endsWith("live-imessage.js")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
