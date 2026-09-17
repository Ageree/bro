import { Composio } from "@composio/core";
import { EveProvider } from "@composio/experimental/eve";
import { isSharedPrincipal } from "./tenant.ts";
import { withDeadline } from "./deadline.ts";

function assertKey(): void {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key || !key.startsWith("ak_") || key.includes("xxxx") || key.includes("your_")) {
    throw new Error(
      "COMPOSIO_API_KEY missing or placeholder. Set it in .env.local from Platform → Getting Started.",
    );
  }
}

function makeClient() {
  assertKey();
  return new Composio({ provider: new EveProvider() });
}

let client: ReturnType<typeof makeClient> | undefined;

export function composio(): ReturnType<typeof makeClient> {
  client ??= makeClient();
  return client;
}

type BroSession = Awaited<ReturnType<ReturnType<typeof makeClient>["create"]>>;

const sessions = new Map<string, Promise<BroSession>>();

/**
 * How long a Composio call may take before we give up on it.
 *
 * Composio was the one third-party lane in the repo with no deadline at all,
 * while every other one clamps hard (fast-ack 700 ms, errand-brief 1.5 s,
 * archive 30 s, browser follow-through 20 min). A freshly connected Gmail does
 * a token exchange and a first sync on the next call, and when that hung the
 * turn hung with it: the человек got the «взялся» line and then nothing, with
 * no upper bound on the wait. A slow answer the model can report is strictly
 * better than a turn that never ends.
 */
const CALL_BUDGET_MS = Number(process.env.BRO_COMPOSIO_BUDGET_MS ?? 45_000);
const SESSION_BUDGET_MS = Number(process.env.BRO_COMPOSIO_SESSION_BUDGET_MS ?? 20_000);

/**
 * Re-exported, not redefined. This helper used to live here, which put it
 * behind the Composio SDK import and out of reach of the one caller that needs
 * it most: the Convex client on the hot path of every tool. It now lives in
 * `agent/lib/deadline.ts`, so every network path shares one definition of
 * "this has stalled", and this export keeps existing importers working.
 */
export { withDeadline } from "./deadline.ts";

function requireUserId(userId: string): string {
  const id = userId.trim();
  // One shared-principal predicate for the whole agent. This list used to be a
  // local copy that happened to omit `local-dev`, which is exactly the id
  // `tenantId()` handed out for any turn without a principal — so those turns
  // all met on one Composio user and read each other's mail.
  if (isSharedPrincipal(id)) {
    throw new Error("refusing shared Composio user id");
  }
  return id;
}

/** One private Composio session per Bro tenant. Connections stay on this user id. */
export function sessionFor(userId: string): Promise<BroSession> {
  // ponytail: process-local cache. Upgrade: persist session.sessionId on tenants and composio.use() across Vercel isolates.
  const id = requireUserId(userId);
  const hit = sessions.get(id);
  if (hit) return hit;
  // The cache holds the promise, so a `create()` that never settles used to
  // poison this tenant for the life of the warm isolate: every later turn
  // awaited the same dead promise and went silent too. The deadline turns that
  // hang into a rejection, and the rejection evicts the entry, so the next
  // turn gets a fresh attempt instead of inheriting the broken one.
  const pending = withDeadline(
    composio().create(id),
    SESSION_BUDGET_MS,
    "composio session",
  ).catch((err: unknown) => {
    sessions.delete(id);
    throw err;
  });
  sessions.set(id, pending);
  return pending;
}

export { CALL_BUDGET_MS };
