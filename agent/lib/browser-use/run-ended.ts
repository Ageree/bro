import { createHmac, timingSafeEqual } from "node:crypto";
import { browserVmWorkspace, isBrowserVmId } from "@agent/lib/browser-vm/ids";
import { browserVmKey } from "@agent/lib/browser-vm/token";
import { applicationOrigin } from "@shared/environment/origin";

/**
 * Where a browser VM's worker says a run has ended
 * (BROWSER_FAST_DELIVERY_WORKSPACES, `agent/channels/browser-run-ended.ts`).
 * Under `/eve/v1/`, the only prefix that reaches eve in production.
 */
export const browserRunEndedPath = "/eve/v1/browser-run-ended";

/**
 * The address the worker is given for a run's end, or undefined when Bro's
 * own origin is unknown or not https: the run then ends as before, at Bro's
 * next look at it.
 */
export function browserRunEndedUrl() {
  try {
    const url = new URL(browserRunEndedPath, applicationOrigin());
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the worker signs for a run (`notify_ended` in
 * `browser-vm/worker/worker.py`): its name, with the VM's key. The word
 * carries no result and no time. All it makes Bro do is read the run from the
 * worker, as its next look would, so a replay costs one look and a clock that
 * lags after a restore breaks nothing.
 */
function browserRunEndedSignature(runId: string) {
  return createHmac("sha256", browserVmKey(browserVmWorkspace(runId)))
    .update(`run-ended.${runId}`)
    .digest("hex");
}

/** Whether a word that a run ended is from the worker of the VM that run is on. */
export function browserRunEndedSignatureValid(
  runId: string,
  signature: string | null
) {
  if (
    !isBrowserVmId(runId) ||
    !signature ||
    !/^[0-9a-f]{64}$/u.test(signature)
  ) {
    return false;
  }
  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(browserRunEndedSignature(runId))
    );
  } catch {
    // A run id that names no workspace, or a signing key that is not set.
    return false;
  }
}
