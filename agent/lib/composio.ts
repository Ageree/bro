import { Composio } from "@composio/core";
import { EveProvider } from "@composio/experimental/eve";

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

function requireUserId(userId: string): string {
  const id = userId.trim();
  if (!id || id === "unknown" || id === "default" || id === "eve:app") {
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
  const pending = composio()
    .create(id)
    .catch((err: unknown) => {
      sessions.delete(id);
      throw err;
    });
  sessions.set(id, pending);
  return pending;
}
