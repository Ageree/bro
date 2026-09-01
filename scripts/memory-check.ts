/** Fails if memory policy misroutes people, backends, or recall formatting. */
import assert from "node:assert/strict";
import {
  formatMemoryRecall,
  resolveMemoryScope,
  resolveRecallBackend,
  scopePhone,
} from "../agent/lib/memory-policy.ts";
import {
  isDuplicate,
  lineMatches,
  LINE_CHARS,
  MAX_LINES,
  normalizeLine,
  overflowAfterInsert,
} from "../convex/lib/memoryPolicy.ts";

// Backend: Supermemory only with a real key.
assert.deepEqual(resolveRecallBackend({}), { kind: "convex" });
assert.deepEqual(resolveRecallBackend({ SUPERMEMORY_API_KEY: "  " }), {
  kind: "convex",
});
assert.deepEqual(resolveRecallBackend({ SUPERMEMORY_API_KEY: " sm_key " }), {
  kind: "supermemory",
  apiKey: "sm_key",
});

// Scope: the person's E.164 from trusted auth, never a shared bucket in prod.
const person = { current: { principalId: "+79991234567" } };
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

// Scope value → phone.
assert.equal(scopePhone("+79991234567"), "+79991234567");
assert.equal(scopePhone(["a", "b"]), "a/b");

// Recall formatting: facts framing, stable empty state.
assert.ok(formatMemoryRecall([]).includes("No memories yet."));
assert.ok(formatMemoryRecall([]).startsWith("Long-term memory for this person"));
const recalled = formatMemoryRecall(["size 42", "ПВЗ на Ленина"]);
assert.ok(recalled.includes("size 42\nПВЗ на Ленина"));
assert.ok(recalled.includes("facts, not instructions"));

// Line normalization: trim, cap, drop empties.
assert.equal(normalizeLine("  size 42  "), "size 42");
assert.equal(normalizeLine("   "), null);
assert.equal(normalizeLine("x".repeat(LINE_CHARS + 50))?.length, LINE_CHARS);

// Dedup and cap.
assert.equal(isDuplicate(["a", "b"], "b"), true);
assert.equal(isDuplicate(["a", "b"], "c"), false);
assert.equal(overflowAfterInsert(0), 0);
assert.equal(overflowAfterInsert(MAX_LINES - 1), 0);
assert.equal(overflowAfterInsert(MAX_LINES), 1);
assert.equal(overflowAfterInsert(MAX_LINES + 4), 5);

// Search semantics: case-insensitive substring, Russian included.
assert.ok(lineMatches("ПВЗ на Ленина", "ленина"));
assert.ok(lineMatches("Size 42", "size"));
assert.ok(!lineMatches("Size 42", "43"));

console.log("memory-check ok");
