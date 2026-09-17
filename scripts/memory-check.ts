/**
 * Memory is ONE store now: Supermemory, in two eve slots.
 *
 * This file used to also cover the hand-rolled Convex `memo` line store —
 * `normalizeLine`, the 400-line cap, substring search. That store is gone, so
 * what is left to guard is the part that can silently break: who a slot locks
 * to, that a missing key is loud rather than a memory-less agent, and that a
 * recalled block cannot survive into another person's conversation.
 */
import assert from "node:assert/strict";
import {
  createMemoryLock,
  applyMemoryRecallBatches,
  projectMemoryHistory,
} from "../node_modules/eve/dist/src/shared/memory-state.js";
import {
  resolveMemoryScope,
  resolveSupermemoryScope,
  scopePhone,
  supermemoryKey,
} from "../agent/lib/memory-policy.ts";
import recallSlot from "../agent/memory/recall.ts";
import archiveSlot from "../agent/memory/archive.ts";
import { src, withEnv } from "./lib/check.ts";

// ── The key is REQUIRED and fails by name ────────────────────────────────────
// It used to be optional: both Supermemory slots resolved their scope to null
// and the Convex memo store carried on. With memo deleted the same silence
// would mean an agent that remembers nothing and never says so.
for (const bad of [undefined, "", "   ", "your_key_here", "sk_xxxx"]) {
  assert.throws(
    () => supermemoryKey({ SUPERMEMORY_API_KEY: bad }),
    /SUPERMEMORY_API_KEY/,
    `"${bad}" must not pass as a key`,
  );
}
assert.equal(supermemoryKey({ SUPERMEMORY_API_KEY: " sm_key " }), "sm_key");

const person = { current: { principalId: "+79991234567" } };
withEnv({ SUPERMEMORY_API_KEY: undefined }, () => {
  assert.throws(
    () => resolveSupermemoryScope(person, true),
    /SUPERMEMORY_API_KEY/,
    "a slot must not quietly disable itself when the key is missing",
  );
});
withEnv({ SUPERMEMORY_API_KEY: "sm_check_key" }, () => {
  assert.equal(resolveSupermemoryScope(person, true), "+79991234567");
  assert.equal(resolveSupermemoryScope({}, true), null, "no person, no slot");
});

// ── Scope: the person's E.164 from trusted auth, never a shared bucket ───────
assert.equal(resolveMemoryScope(person, true), "+79991234567");
assert.equal(
  resolveMemoryScope({ initiator: { principalId: "+79991234567" } }, true),
  "+79991234567",
);
for (const shared of ["", "unknown", "default", "eve:app"]) {
  assert.equal(
    resolveMemoryScope({ current: { principalId: shared } }, true),
    null,
    `shared principal "${shared}" must disable memory in production`,
  );
}
assert.equal(resolveMemoryScope({}, true), null);
assert.equal(resolveMemoryScope({}, false), "local-dev");
assert.equal(resolveMemoryScope({ current: { principalId: "eve:app" } }, false), "local-dev");

assert.equal(scopePhone("+79991234567"), "+79991234567");
assert.equal(scopePhone(["a", "b"]), "a/b");

// ── visibility: "scope" — the cross-conversation leak, pinned behaviourally ──
// `projectMemoryHistory` (eve/dist/src/shared/memory-state.js) drops an
// already-injected recall block on a scope change ONLY when the LOCK says
// `visibility === "scope"`. Anything else and a block injected under person A
// stays in that eve session's history after the slot re-locks to person B.
// Asserting the string on the definition is not enough — this drives the eve
// code that reads it, so the day the field moves or its meaning flips, this
// fails instead of leaking.
function leakTest(visibility: "scope" | "session"): number {
  const turn = { id: "t1", input: [], sequence: 0 };
  const lockFor = (phone: string) =>
    createMemoryLock({
      namespace: "bro-recall-v1",
      scope: phone,
      slot: "recall",
      turn,
      visibility,
    });
  const injected = applyMemoryRecallBatches({
    batches: [
      {
        lock: lockFor("+79990000001"),
        messages: [{ content: "person A said: ПВЗ на Ленина" }],
        operationId: "op-a",
      },
    ],
    history: [],
    state: undefined,
  });
  // Same slot, same namespace, DIFFERENT person — the next conversation.
  const projected = projectMemoryHistory({
    locks: { recall: lockFor("+79990000002") },
    messages: injected.history,
  });
  return projected.length;
}
assert.equal(leakTest("scope"), 0, "a recall block must not survive a scope change");
assert.equal(
  leakTest("session"),
  1,
  "guard against a no-op test: with visibility session the block DOES survive",
);

for (const [name, slot] of [
  ["recall", recallSlot],
  ["archive", archiveSlot],
] as const) {
  assert.equal(slot.visibility, "scope", `${name} must lock recall to the scope`);
}

// ── The memo store is gone, not half-gone ───────────────────────────────────
const instructions = src("agent/instructions.md");
assert.ok(!instructions.includes("memo__"), "no instruction names a deleted tool");
assert.ok(
  instructions.includes("recall__remember"),
  "the instruction says where a durable fact goes now",
);
assert.ok(!src("convex/schema.ts").includes("memories:"), "no memories table");
const convexClient = src("agent/lib/convex.ts");
assert.ok(!convexClient.includes("api.memories"), "no client left pointing at the table");
for (const dead of ["wakeLines", "noteLine", "searchLines", "forgetLines"]) {
  assert.ok(!convexClient.includes(dead), `${dead} is gone with its store`);
}

console.log("memory-check ok");
