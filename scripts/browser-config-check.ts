/**
 * Config-error incident guard (goal.md today's incident): a missing
 * BROWSERUSE_API_KEY on the Convex deployment must fail loudly, not degrade
 * to hydrate's transient-miss "unknown" placeholder — that degrade is what
 * let every follow-through poll burn the full 20-minute give-up budget while
 * the deployment was silently broken. See convex/lib/browseruse.ts,
 * convex/browserFollow.ts, and scripts/deploy.sh.
 */
import { assert, src, withEnv } from "./lib/check.ts";
import {
  getProfile,
  hydrate,
  pollStatus,
  isBrowserUseConfigError,
} from "../convex/lib/browseruse.ts";

const NO_KEY = { BROWSERUSE_API_KEY: undefined, BROWSER_USE_API_KEY: undefined };
const FAKE_PROFILE_ID = "12345678-1234-4123-8123-123456789012";

// ============================================================================
// 1. key() missing → a config error recognisable by isBrowserUseConfigError,
//    not a generic Error an ordinary transient-failure catch would swallow.
//    getProfile has no guarding .catch around its bu() call, so it surfaces
//    key()'s throw directly.
// ============================================================================

// withEnv's callback is synchronous, so it only needs to *start* the call —
// key() throws (or doesn't) synchronously before bu()'s first await, so the
// promise it returns is already committed to reject once env is restored;
// awaiting it after withEnv returns still observes that same rejection.
let getProfilePromise!: Promise<unknown>;
withEnv(NO_KEY, () => {
  getProfilePromise = getProfile(FAKE_PROFILE_ID);
});
try {
  await getProfilePromise;
  throw new Error("getProfile should have thrown with no API key");
} catch (err) {
  assert(isBrowserUseConfigError(err), "missing key throws a recognisable config error");
  assert(
    err instanceof Error && err.message.includes("BROWSERUSE_API_KEY"),
    "config error message names the missing var",
  );
}

// A plain network/4xx error must NOT be mistaken for a config error.
assert(
  !isBrowserUseConfigError(new Error("browser-use 404 /runs/x: not found")),
  "an ordinary browser-use error is not misclassified as a config error",
);
assert(!isBrowserUseConfigError(undefined), "isBrowserUseConfigError is safe on non-Error values");

// ============================================================================
// 2. hydrate() with the key unset must reject — not resolve status:"unknown"
//    the way a real transient upstream miss does. This is the exact
//    regression: hydrate's primary-fetch .catch used to swallow every
//    failure, key-missing included.
// ============================================================================

let hydratePromise!: Promise<unknown>;
withEnv(NO_KEY, () => {
  hydratePromise = hydrate("run1");
});
{
  let threw = false;
  try {
    await hydratePromise;
  } catch (err) {
    threw = true;
    assert(isBrowserUseConfigError(err), "hydrate rejects with a recognisable config error");
  }
  assert(threw, "hydrate() must reject when the API key is missing, never resolve unknown");
}

// pollStatus must not swallow the same failure either — it calls bu() before
// ever reaching hydrate's fallback.
let pollStatusPromise!: Promise<unknown>;
withEnv(NO_KEY, () => {
  pollStatusPromise = pollStatus("run1");
});
{
  let threw = false;
  try {
    await pollStatusPromise;
  } catch (err) {
    threw = true;
    assert(isBrowserUseConfigError(err), "pollStatus rejects with a recognisable config error");
  }
  assert(threw, "pollStatus() must reject when the API key is missing, never resolve unknown");
}

// ============================================================================
// 3. followThrough: the poll step is wrapped so a final step failure stalls
//    the tenant and wakes the human with phase:"failed" instead of the
//    workflow just dying (source assertions — this is a workflow handler,
//    not unit-testable without a running Convex workflow harness).
// ============================================================================

{
  const text = src("convex/browserFollow.ts");
  const pollCallIdx = text.indexOf("internal.browserFollow.pollRun");
  assert(pollCallIdx !== -1, "followThrough still calls pollRun");
  const tryIdx = text.lastIndexOf("try {", pollCallIdx);
  assert(tryIdx !== -1, "the pollRun step call is wrapped in a try block");
  const catchIdx = text.indexOf("} catch (err) {", pollCallIdx);
  assert(catchIdx !== -1 && catchIdx > pollCallIdx, "pollRun step call is followed by a catch");
  const catchBlockEnd = text.indexOf("\n    if (poll.stale)", catchIdx);
  assert(catchBlockEnd !== -1, "catch block precedes the poll.stale branch");
  const catchBlock = text.slice(catchIdx, catchBlockEnd);
  // The stall+wakeup work itself lives in a helper (pollStepFailed), not
  // inlined here — inlining it would put a second, earlier
  // "internal.browserFollow.wakeupAgent" text occurrence ahead of
  // stopGivenUpRun's own call, which scripts/browser-policy-check.ts (owned
  // by another in-flight change) asserts always comes first for the give-up
  // path. Checking the helper is called, and checking the helper's own body
  // separately below, covers the same behaviour without that collision.
  assert(
    /pollStepFailed\(\s*step,\s*args,\s*i\s*\)/.test(catchBlock),
    "on poll-step failure, the shared pollStepFailed helper is called",
  );
  assert(
    /return\s*\{\s*outcome:\s*"done"\s*\}/.test(catchBlock),
    "followThrough returns outcome:\"done\" after handling a poll-step failure (not left hanging)",
  );

  const helperIdx = text.indexOf("async function pollStepFailed(");
  assert(helperIdx !== -1, "pollStepFailed helper is defined");
  const helperEnd = text.indexOf("\nconst WAKEUP_SCAN_PAGE", helperIdx);
  assert(helperEnd !== -1, "pollStepFailed helper body located");
  const helperBody = text.slice(helperIdx, helperEnd);
  assert(
    helperBody.includes("internal.tenants.patchBrowserInternal") &&
      helperBody.includes("STALLED_STATUS"),
    "pollStepFailed marks the tenant STALLED_STATUS",
  );
  assert(
    helperBody.includes("internal.browserFollow.wakeupAgent"),
    "pollStepFailed invokes wakeupAgent",
  );
  assert(
    /phase:\s*"failed"/.test(helperBody),
    "pollStepFailed wakes with phase:\"failed\" (eve's already-built giveup/retry prompt)",
  );
  assert(
    helperBody.includes("wakeupStepRetry"),
    "pollStepFailed reuses wakeupStepRetry like every other wakeupAgent call",
  );
  assert(
    !helperBody.includes("cancelRunAction"),
    "pollStepFailed never cancels the Cloud run — our side being broken doesn't mean the run is",
  );
}

// ============================================================================
// 4. deploy.sh checks the Convex deployment's env before `convex deploy`.
// ============================================================================

{
  const text = src("scripts/deploy.sh");
  assert(text.includes("convex env list"), "deploy.sh reads the Convex deployment's env vars");
  assert(text.includes("BROWSERUSE_API_KEY"), "deploy.sh checks for BROWSERUSE_API_KEY");
  assert(text.includes("BROWSER_USE_API_KEY"), "deploy.sh also accepts the BROWSER_USE_API_KEY alias");
  assert(text.includes("EVE_URL"), "deploy.sh checks for EVE_URL");
  assert(text.includes("BRO_INTERNAL_SECRET"), "deploy.sh checks for BRO_INTERNAL_SECRET");
  assert(text.includes("--skip-env-check"), "deploy.sh supports --skip-env-check");
  const envCheckIdx = text.indexOf("checking convex env");
  const deployIdx = text.indexOf("convex deploy --typecheck");
  assert(
    envCheckIdx !== -1 && deployIdx !== -1 && envCheckIdx < deployIdx,
    "the env check runs before `convex deploy`",
  );
}

console.log("browser-config-check ok");
