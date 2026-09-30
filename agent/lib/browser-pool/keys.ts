import { createHash, createHmac, hkdfSync } from "node:crypto";
import { env } from "@shared/environment";

/**
 * The keys and names of the browser pool that Bro derives instead of
 * storing: a workspace's data key, a host's token key, a workspace's
 * sandbox id.
 */

/**
 * The key a workspace's sets are sealed with (docs/browser-pool.md,
 * section 5): HKDF-SHA256 of BROWSER_STATE_KEY with the workspace id as its
 * info, as 64 hex characters, the way `hostd` takes it (`dataKey`). It goes
 * with each park or restore and lives only in `hostd`'s memory, never in
 * Object Storage; changing BROWSER_STATE_KEY leaves every set unreadable.
 */
export function browserStateDataKey(workspaceId: string) {
  const stateKey = env.BROWSER_STATE_KEY;
  if (stateKey === undefined) {
    throw new Error("BROWSER_STATE_KEY is not configured.");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(stateKey, "hex"),
      Buffer.alloc(0),
      Buffer.from(workspaceId, "utf8"),
      32
    )
  ).toString("hex");
}

/**
 * The key one host's `hostd` checks tokens with: HMAC-SHA256 of
 * BROWSER_VM_SIGNING_KEY and `bro-browser-host:<host id>`, as `host_key` in
 * `browser-vm/host/boot.py` writes it into the host's cloud-init. A key read
 * off one host opens no other host and no worker (theirs are derived with
 * `bro-browser-vm:`).
 */
export function browserHostKey(hostId: string) {
  const signingKey = env.BROWSER_VM_SIGNING_KEY;
  if (signingKey === undefined) {
    throw new Error("BROWSER_VM_SIGNING_KEY is not configured.");
  }
  return createHmac("sha256", Buffer.from(signingKey, "hex"))
    .update(`bro-browser-host:${hostId}`)
    .digest();
}

/**
 * The sandbox id of a workspace's browser on any host: `hostd` takes only
 * `[a-z0-9-]{1,63}` (it goes into paths and Caddy routes), and a workspace
 * id holds a colon, so it is `ws-` and 40 hex of the id's SHA-256. The same
 * workspace always gets the same id, which also names its sets in Object
 * Storage.
 */
export function browserSandboxId(workspaceId: string) {
  return `ws-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 40)}`;
}
