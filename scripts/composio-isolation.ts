import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { composioUserId } from "../agent/lib/tenant.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function throws(fn: () => unknown, msg: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

throws(() => composioUserId("unknown"), "must refuse unknown");
throws(() => composioUserId("default"), "must refuse default");
throws(() => composioUserId("eve:app"), "must refuse eve:app");
throws(() => composioUserId("  "), "must refuse blank");
assert(composioUserId("+15551234567") === "+15551234567", "e164");
assert(composioUserId("local-dev") === "local-dev", "local-dev ok for TUI");
console.log("userid_ok");

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

const { composio, sessionFor } = await import("../agent/lib/composio.ts");

const stamp = Date.now().toString(36);
const userA = `bro-iso-a-${stamp}`;
const userB = `bro-iso-b-${stamp}`;

try {
  await sessionFor("unknown");
  throw new Error("sessionFor must refuse unknown");
} catch (err) {
  assert(
    err instanceof Error && err.message === "refusing shared Composio user id",
    "sessionFor must refuse unknown",
  );
}

const sessionA = await sessionFor(userA);
const sessionB = await sessionFor(userB);
assert(sessionA.sessionId !== sessionB.sessionId, "sessions must not be shared");
assert(sessionFor(userA) === sessionFor(userA), "same user reuses in-process session");

let pendingId: string | undefined;
try {
  const link = await sessionA.authorize("github");
  pendingId = link.id;
  assert(Boolean(link.redirectUrl), "connect link missing");
  assert(Boolean(pendingId), "connected account id missing");
  console.log("connect_for", userA, "account", pendingId);

  const listA = await composio().connectedAccounts.list({ userIds: [userA] });
  const listB = await composio().connectedAccounts.list({ userIds: [userB] });
  const idsA = new Set(listA.items.map((item) => item.id));
  const idsB = new Set(listB.items.map((item) => item.id));

  assert(idsA.has(pendingId!), "A must see own pending github");
  assert(!idsB.has(pendingId!), "B must not see A's github");

  const githubB = await sessionB.toolkits({ toolkits: ["github"] });
  const bConn = githubB.items[0]?.connection;
  assert(
    !bConn?.isActive && bConn?.connectedAccount?.id !== pendingId,
    "B github must not use A's account",
  );

  console.log("isolation_ok", { a: listA.items.length, b: listB.items.length });
} finally {
  if (pendingId) {
    try {
      await composio().connectedAccounts.delete(pendingId);
      console.log("cleaned", pendingId);
    } catch (err) {
      console.error("cleanup failed", err instanceof Error ? err.message : err);
    }
  }
}
