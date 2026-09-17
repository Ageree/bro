/**
 * Fails if a turn without a person attached can still resolve to a tenant key.
 *
 * This is the regression pin for a leak that every other check passed over.
 * `tenantId()` used to return the literal `"local-dev"` for any turn whose auth
 * carried no principal, and the guards downstream each kept their own list of
 * "shared" ids — none of which contained `local-dev`. So those turns all met on
 * one Composio user (one Gmail, one calendar, one set of triggers), one jobs
 * list, one set of wakeups and one orders table. A person who had just
 * connected their mailbox could be read back someone else's.
 *
 * The rule under test is therefore not "the string is rejected here" but "no
 * entry point turns a person-less turn into a usable tenant key anywhere".
 */
import assert from "node:assert/strict";
import {
  composioUserId,
  isSharedPrincipal,
  requirePersonalPhone,
  tenantId,
} from "../agent/lib/tenant.ts";
import { withDeadline } from "../agent/lib/composio.ts";

/** Every id that names no single person. `local-dev` is the one that leaked. */
const SHARED = ["", "   ", "unknown", "default", "eve:app", "local-dev"];
const REAL = "+79991234567";

function turn(principalId?: string | null, side: "current" | "initiator" = "current") {
  return { session: { auth: { [side]: principalId === undefined ? undefined : { principalId } } } };
}

// The predicate itself.
for (const id of SHARED) {
  assert.equal(isSharedPrincipal(id), true, `"${id}" must count as shared`);
}
assert.equal(isSharedPrincipal(REAL), false);
assert.equal(isSharedPrincipal(undefined), true);
assert.equal(isSharedPrincipal(null), true);

// A real person resolves, from either side of the auth box.
delete process.env.BRO_LOCAL_DEV_PRINCIPAL;
assert.equal(tenantId(turn(REAL)), REAL);
assert.equal(tenantId(turn(REAL, "initiator")), REAL);
assert.equal(tenantId(turn(` ${REAL} `)), REAL, "a padded principal is still that person");

// Every shared id, and a turn with no auth at all, must throw rather than
// fall back to a bucket two people can share.
for (const id of SHARED) {
  assert.throws(
    () => tenantId(turn(id)),
    /refusing shared principal/,
    `tenantId must refuse "${id}" instead of returning a shared key`,
  );
}
assert.throws(() => tenantId(turn(undefined)), /refusing shared principal/);
assert.throws(() => tenantId({ session: { auth: {} } }), /refusing shared principal/);

// The local-dev escape hatch is explicit, opt-in, and cannot itself be shared.
process.env.BRO_LOCAL_DEV_PRINCIPAL = REAL;
assert.equal(
  tenantId({ session: { auth: {} } }),
  REAL,
  "an explicitly configured local principal stands in for a missing one",
);
for (const id of SHARED) {
  process.env.BRO_LOCAL_DEV_PRINCIPAL = id;
  assert.throws(
    () => tenantId({ session: { auth: {} } }),
    /refusing shared principal/,
    `the escape hatch must not launder "${id}" into a tenant key`,
  );
}
delete process.env.BRO_LOCAL_DEV_PRINCIPAL;

// The two narrower guards agree with the predicate — they used to disagree,
// which is how `local-dev` reached Composio while files/sandbox refused it.
for (const id of SHARED) {
  assert.throws(() => composioUserId(id), /refusing shared/, `composioUserId("${id}")`);
  assert.throws(() => requirePersonalPhone(id), /refusing shared/, `requirePersonalPhone("${id}")`);
}
assert.equal(composioUserId(` ${REAL} `), REAL);
assert.equal(requirePersonalPhone(` ${REAL} `), REAL);

// Deadlines: a third-party call that never settles must not hold a turn open.
const slow = await withDeadline(
  new Promise((resolve) => setTimeout(resolve, 50)).then(() => "late"),
  5,
  "slow call",
).then(
  () => "resolved",
  (err: unknown) => String((err as Error).message),
);
assert.match(slow, /slow call timed out after 5 ms/, "a hung call must reject, not hang");

const quick = await withDeadline(Promise.resolve("done"), 1000, "quick call");
assert.equal(quick, "done", "a call inside its budget passes its value through");

const failing = await withDeadline(
  Promise.reject(new Error("upstream said no")),
  1000,
  "failing call",
).catch((err: unknown) => String((err as Error).message));
assert.equal(failing, "upstream said no", "a real error is not masked by the deadline");

// A zero or nonsense budget means "no deadline", never "reject immediately":
// a misconfigured env var must not take every Composio call down with it.
assert.equal(await withDeadline(Promise.resolve("ok"), 0, "unbudgeted"), "ok");
assert.equal(await withDeadline(Promise.resolve("ok"), Number.NaN, "unbudgeted"), "ok");

console.log("scope-check ok");
