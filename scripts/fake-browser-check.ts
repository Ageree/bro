// The fake Browser Use service, driven by the real client.
//
// A stand-in is only useful if the production client can actually talk to it:
// the same paths, the same response shapes, the same places the live-view URL
// and the final labelled block are read from. So this starts the fake and then
// runs `agent/lib/browseruse.ts` against it — not a copy of it — and checks
// that a run comes back as a `CloudOutcome` the rest of Bro can act on.
//
// No network and no API key beyond a placeholder, so it runs in CI.
import { spawn } from "node:child_process";
import { once } from "node:events";

import { parseCloudOutcome } from "../convex/lib/browserOutcomePolicy.ts";
import { isLiveViewUrl } from "../convex/lib/browserLivePolicy.ts";
import { isBrowserProfileId } from "../convex/lib/browserProfilePolicy.ts";

import { assert, eq, src } from "./lib/check.ts";

/** Runs finish fast here; the real default exists to exercise progress notes. */
const RUN_MS = 400;

const fake = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    new URL("./fake-browser-use.ts", import.meta.url).pathname,
    "--port=0",
    `--run-ms=${RUN_MS}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

const port = await new Promise<number>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("fake did not start")), 10_000);
  fake.stdout.on("data", (chunk: Buffer) => {
    const found = /listening on :(\d+)/.exec(chunk.toString());
    if (found) {
      clearTimeout(timer);
      resolve(Number(found[1]));
    }
  });
  fake.on("error", reject);
});

process.env.BROWSER_USE_BASE_URL = `http://127.0.0.1:${port}/api/v4`;
process.env.BROWSER_USE_API_KEY = "fake-key";
process.env.BROWSERUSE_API_KEY = "fake-key";

// Imported after the env is set only for tidiness — the client reads the base
// per call, which is itself the property that lets staging point elsewhere
// without a restart.
const { cancelRun, createProfile, startRun, waitForRun } = await import(
  "../agent/lib/browseruse.ts"
);

try {
  const profileId = await createProfile("+15555550101");
  assert(isBrowserProfileId(profileId), `fake profile id is a real uuid: ${profileId}`);

  // ------------------------------------------------- a purchase that lands
  const bought = await startRun("купи молоко на wildberries", undefined, { profileId });
  assert(bought.runId, "a run comes back with an id");
  assert(isLiveViewUrl(bought.liveUrl ?? ""), `live view url: ${bought.liveUrl}`);

  const done = await waitForRun(bought.runId, bought.sessionId, 8000);
  eq(done.status, "completed", "the run reaches a terminal state");
  const outcome = parseCloudOutcome(done.result);
  assert(outcome.labelled, "the fake's result carries a real labelled block");
  eq(outcome.needs, "none", "a completed purchase needs nothing from the human");
  eq(outcome.orderId, "4815162342", "the order id survives to the outcome");
  eq(outcome.amountRub, 1290, "the sum is parsed as rubles");
  assert(outcome.when, "a delivery time comes through");

  // ------------------------------------------ a purchase parked on the bank
  const threeDs = await startRun("оплати и подтверди в банке", undefined, { profileId });
  const parked = await waitForRun(threeDs.runId, threeDs.sessionId, 8000);
  const parkedOutcome = parseCloudOutcome(parked.result);
  assert(parkedOutcome.labelled, "the parked result is labelled too");
  eq(parkedOutcome.needs, "3ds", "a bank confirmation parks the run on 3ds");
  assert(
    !parkedOutcome.orderId,
    "a parked run records no order — this is the double-charge guard",
  );

  // ------------------------------------------------------- a run that fails
  const broken = await startRun("открой сломанный сайт", undefined, { profileId });
  const failed = await waitForRun(broken.runId, broken.sessionId, 8000);
  eq(failed.status, "failed", "a failing errand reports failed, not completed");

  // ------------------------------------------------------------- cancelling
  const spare = await startRun("купи хлеб", undefined, { profileId });
  eq(await cancelRun(spare.runId), true, "a run can be cancelled");

  // The fake must never be the default. If this ever passes without the env
  // var, staging config has leaked into the client.
  const clientSrc = src("agent/lib/browseruse.ts");
  assert(
    clientSrc.includes('DEFAULT_BASE = "https://api.browser-use.com/api/v4"'),
    "the real API is still the default base",
  );
  for (const file of ["agent/lib/browseruse.ts", "convex/lib/browseruse.ts"]) {
    assert(
      src(file).includes("BROWSER_USE_BASE_URL"),
      // Follow-through polling runs on Convex, so redirecting only the eve
      // side would start a fake run and then poll the real API for it.
      `${file} honours the base override`,
    );
  }

  console.log("fake browser-use check ok");
} finally {
  fake.kill();
  await once(fake, "close").catch(() => {});
}
