import { isBrowserVmId } from "@agent/lib/browser-vm/ids";

/**
 * Whether an errand runs on the workspace's own browser — a VM of its own
 * or a sandbox of the pool, both behind a `vm:` profile — rather than on
 * Browser Use's cloud, whose cap every workspace shares.
 */
export function onOwnBrowser(profileId: string | null | undefined) {
  return (
    profileId !== null && profileId !== undefined && isBrowserVmId(profileId)
  );
}

/**
 * The least an errand waits before it asks its own browser again after the
 * browser said it is starting or busy. Asking costs no shared slot and no
 * 429 to anyone else, so the wait is the browser's own guess (a sandbox
 * being moved onto its host says 15 s) rather than the minute a Browser Use
 * errand waits: on 04.10 every such answer cost a whole minute, and the
 * minute tick rounded it up to the next one.
 */
export const ownBrowserRetryMs = 15_000;
