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

// A key pasted into a hosted env arrives wrapped, with a newline in the MIDDLE
// of the value — `fetch` then refuses to send the header at all, so memory is
// not degraded but dead. `.trim()` cannot see an interior break. Observed on a
// real 90-character key that arrived as 92. Same breakage the Browser Use key
// hit in production; this one matters more, because it is the only memory Bro
// has and it is no longer optional.
for (const wrapped of [
  "sm_abc\ndef",
  "sm_abc\r\ndef",
  " sm_abc\n def \n",
  "sm_abc\tdef",
]) {
  const cleaned = supermemoryKey({ SUPERMEMORY_API_KEY: wrapped });
  assert.equal(cleaned, "sm_abcdef", `interior whitespace must go: ${JSON.stringify(wrapped)}`);
  assert.doesNotThrow(
    () => new Headers({ authorization: `Bearer ${cleaned}` }),
    "the cleaned key must be sendable as a header",
  );
}
assert.throws(
  () => new Headers({ authorization: "Bearer sm_abc\ndef" }),
  "guard is meaningless unless fetch really rejects the wrapped form",
);

const person = { current: { principalId: "+79991234567" } };
withEnv({ SUPERMEMORY_API_KEY: undefined, BRO_MEMORY_OPTIONAL: undefined }, () => {
  assert.throws(
    () => resolveSupermemoryScope(person),
    /SUPERMEMORY_API_KEY/,
    "a slot must not quietly disable itself when the key is missing",
  );
});
withEnv({ SUPERMEMORY_API_KEY: "sm_check_key", BRO_MEMORY_OPTIONAL: undefined }, () => {
  assert.equal(resolveSupermemoryScope(person), "+79991234567");
  assert.equal(resolveSupermemoryScope({}), null, "no person, no slot");
});

// Running memoryless is allowed, but only when somebody typed it out. The
// throw above is right for a deployment and wrong as the only option: it would
// take every turn down over a key the operator may not have bought, and it
// would make this repo's own live conversation suite impossible to run.
withEnv({ SUPERMEMORY_API_KEY: undefined, BRO_MEMORY_OPTIONAL: "1" }, () => {
  assert.equal(
    resolveSupermemoryScope(person),
    null,
    "an explicit opt-out disables the slot instead of throwing",
  );
});
for (const notOptIn of [undefined, "", "0", "no", "off"]) {
  withEnv({ SUPERMEMORY_API_KEY: undefined, BRO_MEMORY_OPTIONAL: notOptIn }, () => {
    assert.throws(
      () => resolveSupermemoryScope(person),
      /SUPERMEMORY_API_KEY/,
      `"${notOptIn}" must not read as an opt-out — nobody falls into memorylessness`,
    );
  });
}

// ── Scope: the person's E.164 from trusted auth, never a shared bucket ───────
//
// The old signature took a `production` flag meaning `NODE_ENV === "production"`
// and fell back to the literal "local-dev" whenever it was false — a variable
// nothing in this repository sets. Every person-less turn then shared one
// memory bucket. The flag is gone; the only way to name a scope without a
// principal is to set BRO_LOCAL_DEV_PRINCIPAL yourself.
assert.equal(resolveMemoryScope(person), "+79991234567");
assert.equal(
  resolveMemoryScope({ initiator: { principalId: "+79991234567" } }),
  "+79991234567",
);
for (const shared of ["", "unknown", "default", "eve:app", "local-dev"]) {
  assert.equal(
    resolveMemoryScope({ current: { principalId: shared } }),
    null,
    `shared principal "${shared}" must disable memory, never share a bucket`,
  );
}
assert.equal(resolveMemoryScope({}), null, "no principal, no memory scope");
withEnv({ BRO_LOCAL_DEV_PRINCIPAL: "+79990000001" }, () => {
  assert.equal(
    resolveMemoryScope({}),
    "+79990000001",
    "an explicitly configured local principal names the scope",
  );
  assert.equal(
    resolveMemoryScope(person),
    "+79991234567",
    "a real principal always wins over the local stand-in",
  );
});
withEnv({ BRO_LOCAL_DEV_PRINCIPAL: "local-dev" }, () => {
  assert.equal(
    resolveMemoryScope({}),
    null,
    "the escape hatch cannot launder a shared value into a memory scope",
  );
});

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
