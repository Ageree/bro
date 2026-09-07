/** Cloud/AI live iMessage lane. The tester is a dedicated Inkbox line
 *  that plays the human over real blue bubbles. Shared-pool identities
 *  cannot start a conversation — that is the only reason this needs a
 *  dedicated number, not a second stack. */

export const DEFAULT_TESTER_HANDLE = "bro-live-tester";
export const DEFAULT_BRO_HANDLE = "bro-live-bro";
export const TESTER_CLAIM_KEY = "bro-live-tester-line-v1";
export const DEDICATED_UPGRADE_URL =
  "https://inkbox.ai/console/organizations?tab=billing";

/** Startup $200: dedicated line that can start conversations. */
export const DEDICATED_PLAN_HINT =
  "Inkbox Startup with a start-capable dedicated iMessage number";

export const E164_RE = /^\+[1-9]\d{6,14}$/;

export type LiveBlocker =
  | "no_api_key"
  | "no_tester"
  | "no_dedicated_line"
  | "quota"
  | "identity_cap";

export type ListenBlocker = "no_api_key" | "no_bro" | "no_assignment";

export type LiveLaneStatus = {
  ready: boolean;
  blocker?: LiveBlocker;
  detail?: string;
  testerHandle: string;
  broHandle: string;
  testerNumber?: string;
  routerNumber?: string;
  connectCommand?: string;
};

export type LiveListenStatus = {
  ready: boolean;
  blocker?: ListenBlocker;
  detail?: string;
  broHandle: string;
  routerNumber?: string;
  connectCommand?: string;
  assignmentCount: number;
  remotesLast4: string[];
};

export type LiveBubble = {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  media?: string;
  service?: string;
  wasDowngraded?: boolean | null;
  at: number;
};

export type LivePlayTurn = {
  text: string;
  expect?: string;
  connect?: boolean;
};

export type LivePlay = {
  name: string;
  broHandle?: string;
  timeoutMs?: number;
  turns: LivePlayTurn[];
};

export function testerHandleFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.BRO_LIVE_TESTER_HANDLE?.trim();
  return raw || DEFAULT_TESTER_HANDLE;
}

export function broHandleFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BRO_LIVE_BRO_HANDLE?.trim();
  return raw || DEFAULT_BRO_HANDLE;
}

export function isE164(phone: string | undefined | null): boolean {
  return typeof phone === "string" && E164_RE.test(phone);
}

export function parseE164(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const phone = raw.trim();
  return isE164(phone) ? phone : undefined;
}

export function connectCommandFor(handle: string): string {
  const h = handle.trim().replace(/^@/, "");
  if (!h) throw new Error("handle required");
  return `connect @${h}`;
}

export function inboundText(msg: {
  content?: string | null;
  media?: Array<{ url?: string | null }> | null;
}): string {
  const text = typeof msg.content === "string" ? msg.content.trim() : "";
  const urls = (msg.media ?? [])
    .map((m) => (typeof m.url === "string" ? m.url.trim() : ""))
    .filter(Boolean);
  if (text && urls.length) return `${text}\n${urls.join("\n")}`;
  if (text) return text;
  return urls.join("\n");
}

export function bubblesText(bubbles: LiveBubble[]): string {
  return bubbles
    .map((b) => {
      if (b.media && b.text) return `[media ${b.media}] ${b.text}`;
      if (b.media) return `[media ${b.media}]`;
      return b.text;
    })
    .join("\n");
}

export function expectMatches(text: string, expect: string): boolean {
  return new RegExp(expect, "i").test(text);
}

export function parsePlay(raw: unknown): LivePlay {
  if (!raw || typeof raw !== "object") throw new Error("play must be an object");
  const rec = raw as Record<string, unknown>;
  if (typeof rec.name !== "string" || !rec.name.trim()) {
    throw new Error("play.name required");
  }
  if (rec.broHandle !== undefined) {
    if (typeof rec.broHandle !== "string" || !rec.broHandle.trim()) {
      throw new Error("play.broHandle must be a handle");
    }
  }
  if (!Array.isArray(rec.turns) || rec.turns.length === 0) {
    throw new Error("play.turns required");
  }
  const turns: LivePlayTurn[] = rec.turns.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`turn ${i} invalid`);
    const t = item as Record<string, unknown>;
    if (typeof t.text !== "string") throw new Error(`turn ${i} text required`);
    if (t.expect !== undefined && typeof t.expect !== "string") {
      throw new Error(`turn ${i} expect must be a string`);
    }
    return {
      text: t.text,
      expect: typeof t.expect === "string" ? t.expect : undefined,
      connect: t.connect === true,
    };
  });
  return {
    name: rec.name.trim(),
    broHandle:
      typeof rec.broHandle === "string" ? rec.broHandle.trim() : undefined,
    timeoutMs: typeof rec.timeoutMs === "number" ? rec.timeoutMs : undefined,
    turns,
  };
}

export function classifyLane(input: {
  apiKey?: string;
  testerExists: boolean;
  testerNumber?: string;
  quotaBlocked?: boolean;
  identityCapBlocked?: boolean;
  testerHandle: string;
  broHandle: string;
  routerNumber?: string;
}): LiveLaneStatus {
  const connectCommand = connectCommandFor(input.broHandle);
  const base = {
    testerHandle: input.testerHandle,
    broHandle: input.broHandle,
    testerNumber: input.testerNumber,
    routerNumber: input.routerNumber,
    connectCommand,
  };
  if (!input.apiKey) {
    return {
      ...base,
      ready: false,
      blocker: "no_api_key",
      detail: "INKBOX_API_KEY missing",
    };
  }
  if (input.quotaBlocked) {
    return {
      ...base,
      ready: false,
      blocker: "quota",
      detail: `${DEDICATED_PLAN_HINT}: ${DEDICATED_UPGRADE_URL}`,
    };
  }
  if (input.identityCapBlocked) {
    return {
      ...base,
      ready: false,
      blocker: "identity_cap",
      detail: "Inkbox identity cap reached; cannot create the tester",
    };
  }
  if (!input.testerExists) {
    return {
      ...base,
      ready: false,
      blocker: "no_tester",
      detail: `run npm run live -- provision (creates ${input.testerHandle})`,
    };
  }
  if (!isE164(input.testerNumber)) {
    return {
      ...base,
      ready: false,
      blocker: "no_dedicated_line",
      detail: `${input.testerHandle} has no dedicated iMessage number. ${DEDICATED_PLAN_HINT}: ${DEDICATED_UPGRADE_URL}`,
    };
  }
  return { ...base, ready: true };
}

export function remoteLast4(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-4).padStart(4, "?");
}

export function classifyListen(input: {
  apiKey?: string;
  broExists: boolean;
  remotes: string[];
  broHandle: string;
  routerNumber?: string;
}): LiveListenStatus {
  const connectCommand = connectCommandFor(input.broHandle);
  const remotesLast4 = input.remotes.filter(isE164).map(remoteLast4);
  const base = {
    broHandle: input.broHandle,
    routerNumber: input.routerNumber,
    connectCommand,
    assignmentCount: remotesLast4.length,
    remotesLast4,
  };
  if (!input.apiKey) {
    return {
      ...base,
      ready: false,
      blocker: "no_api_key",
      detail: "INKBOX_API_KEY missing",
    };
  }
  if (!input.broExists) {
    return {
      ...base,
      ready: false,
      blocker: "no_bro",
      detail: `run npm run live -- provision --listen (creates ${input.broHandle})`,
    };
  }
  if (remotesLast4.length === 0) {
    return {
      ...base,
      ready: false,
      blocker: "no_assignment",
      detail: `on iPhone, Send as SMS = off, text ${connectCommand} to ${input.routerNumber ?? "the router"} as a blue iMessage`,
    };
  }
  return { ...base, ready: true };
}

/** After connect, Inkbox may have an assignment before any conversation row. */
export function pickListenRemote(opts: {
  assignmentRemotes: string[];
  conversationRemote?: string | null;
}): string | undefined {
  const fromConvo = parseE164(opts.conversationRemote);
  if (fromConvo) return fromConvo;
  return opts.assignmentRemotes.find((n) => isE164(n));
}

export function allowlistWithTester(
  existing: string | undefined,
  testerNumber: string,
): string {
  const have = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!have.includes(testerNumber)) have.push(testerNumber);
  return have.join(",");
}

export function isDedicatedQuotaError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  return (
    name === "DedicatedIMessageNumberQuotaExceededError" ||
    /dedicated outbound iMessage/i.test(msg)
  );
}

export function quietSettled(opts: {
  lastInboundAt: number | undefined;
  now: number;
  quietMs: number;
}): boolean {
  if (opts.lastInboundAt === undefined) return false;
  return opts.now - opts.lastInboundAt >= opts.quietMs;
}
