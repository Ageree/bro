/** Drive Bro through /internal/sim — no iPhone, no Inkbox. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_SIM_PHONE,
  isSimPhone,
  parseSimConversation,
  parseSimPhone,
  type SimBubble,
} from "../agent/lib/sim.ts";

export type SimPlayTurn = {
  text: string;
  expect?: string;
  reset?: boolean;
};

export type SimPlay = {
  name: string;
  phone?: string;
  timeoutMs?: number;
  turns: SimPlayTurn[];
};

export type SimTurnResult = {
  ok: boolean;
  phone: string;
  conversationId: string;
  skippedAgent?: boolean;
  timedOut?: boolean;
  error?: string;
  bubbles: SimBubble[];
};

function loadDotenv(): void {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
}

export function parsePlay(raw: unknown): SimPlay {
  if (!raw || typeof raw !== "object") throw new Error("play must be an object");
  const rec = raw as Record<string, unknown>;
  if (typeof rec.name !== "string" || !rec.name.trim()) {
    throw new Error("play.name required");
  }
  if (rec.phone !== undefined && !isSimPhone(String(rec.phone))) {
    throw new Error("play.phone must be +1555 + 7 digits");
  }
  if (!Array.isArray(rec.turns) || rec.turns.length === 0) {
    throw new Error("play.turns required");
  }
  const turns: SimPlayTurn[] = rec.turns.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`turn ${i} invalid`);
    const t = item as Record<string, unknown>;
    if (typeof t.text !== "string") throw new Error(`turn ${i} text required`);
    if (t.expect !== undefined && typeof t.expect !== "string") {
      throw new Error(`turn ${i} expect must be a string`);
    }
    return {
      text: t.text,
      expect: typeof t.expect === "string" ? t.expect : undefined,
      reset: t.reset === true,
    };
  });
  return {
    name: rec.name.trim(),
    phone: typeof rec.phone === "string" ? rec.phone : undefined,
    timeoutMs: typeof rec.timeoutMs === "number" ? rec.timeoutMs : undefined,
    turns,
  };
}

export function bubblesText(bubbles: SimBubble[]): string {
  return bubbles
    .map((b) => {
      if (b.kind === "tapback") return `[${b.reaction}]`;
      if (b.kind === "media") return `[media ${b.media ?? ""}] ${b.text ?? ""}`.trim();
      if (b.kind === "group") return `[group ${b.to?.join(",") ?? ""}] ${b.text ?? ""}`.trim();
      return b.text ?? "";
    })
    .join("\n");
}

export function expectMatches(text: string, expect: string): boolean {
  return new RegExp(expect, "i").test(text);
}

function eveBase(): string {
  return (process.env.EVE_URL ?? "http://127.0.0.1:2000").replace(/\/$/, "");
}

function secret(): string {
  const s = process.env.BRO_INTERNAL_SECRET;
  if (!s) throw new Error("BRO_INTERNAL_SECRET missing");
  return s;
}

export async function simTurn(opts: {
  text: string;
  phone?: string;
  conversationId?: string;
  reset?: boolean;
  timeoutMs?: number;
}): Promise<SimTurnResult> {
  const res = await fetch(`${eveBase()}/internal/sim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: secret(),
      text: opts.text,
      phone: opts.phone,
      conversationId: opts.conversationId,
      reset: opts.reset,
      timeoutMs: opts.timeoutMs,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as SimTurnResult;
  if (!res.ok) {
    throw new Error(
      body.error ?? `sim HTTP ${res.status} ${JSON.stringify(body)}`,
    );
  }
  return body;
}

export async function simDrain(opts: {
  phone?: string;
  conversationId?: string;
}): Promise<SimTurnResult> {
  const q = new URLSearchParams({ secret: secret() });
  if (opts.phone) q.set("phone", opts.phone);
  if (opts.conversationId) q.set("conversationId", opts.conversationId);
  const res = await fetch(`${eveBase()}/internal/sim?${q}`);
  const body = (await res.json().catch(() => ({}))) as SimTurnResult;
  if (!res.ok) throw new Error(`sim drain HTTP ${res.status}`);
  return body;
}

async function runPlay(play: SimPlay): Promise<void> {
  const phone = play.phone ?? DEFAULT_SIM_PHONE;
  const conversationId = parseSimConversation(undefined, phone);
  console.log(`play ${play.name} ${phone} ${conversationId}`);
  for (const [i, turn] of play.turns.entries()) {
    const result = await simTurn({
      text: turn.text,
      phone,
      conversationId,
      reset: turn.reset,
      timeoutMs: play.timeoutMs,
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

function usage(): never {
  console.error(`Usage:
  npm run sim -- <text>
  npm run sim -- --phone +15550001000 --reset -- <text>
  npm run sim -- --play .harness/plays/help.json
  npm run sim -- --drain [--phone +15550001000]`);
  process.exit(2);
}

async function main(): Promise<void> {
  loadDotenv();
  const argv = process.argv.slice(2);
  let phone = parseSimPhone(process.env.BRO_SIM_PHONE) ?? DEFAULT_SIM_PHONE;
  let reset = false;
  let drain = false;
  let playPath: string | undefined;
  const textParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      textParts.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--phone") {
      const next = argv[++i];
      const parsed = parseSimPhone(next);
      if (!parsed) throw new Error("--phone must be +1555 + 7 digits");
      phone = parsed;
      continue;
    }
    if (arg === "--reset") {
      reset = true;
      continue;
    }
    if (arg === "--drain") {
      drain = true;
      continue;
    }
    if (arg === "--play") {
      playPath = argv[++i];
      continue;
    }
    if (arg.startsWith("-")) usage();
    textParts.push(arg);
  }

  if (playPath) {
    const play = parsePlay(JSON.parse(readFileSync(resolve(playPath), "utf8")));
    await runPlay(play);
    return;
  }
  if (drain) {
    const result = await simDrain({ phone });
    console.log(bubblesText(result.bubbles) || "(empty)");
    return;
  }
  const text = textParts.join(" ").trim();
  if (!text) usage();
  const result = await simTurn({ text, phone, reset });
  console.log(bubblesText(result.bubbles) || "(empty)");
  if (result.timedOut) process.exit(1);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("sim-play.ts") || entry.endsWith("sim-play.js")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
