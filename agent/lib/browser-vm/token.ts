import { createHmac } from "node:crypto";
import { env } from "@shared/environment";

/** The longest a token may live: the worker refuses one valid for longer. */
const maximumTokenSeconds = 900;

/**
 * The key one VM's worker checks tokens with. It is derived from the
 * deployment's signing key and the workspace id, so Bro keeps no per-VM
 * secret, and a key read off one VM's disk opens no other VM. It reaches the
 * VM once, in its cloud-init.
 */
export function browserVmKey(workspaceId: string) {
  const signingKey = env.BROWSER_VM_SIGNING_KEY;
  if (signingKey === undefined) {
    throw new Error("BROWSER_VM_SIGNING_KEY is not configured.");
  }
  return createHmac("sha256", Buffer.from(signingKey, "hex"))
    .update(`bro-browser-vm:${workspaceId}`)
    .digest();
}

/**
 * A short-lived bearer token for one VM's worker, checked by `verify_token`
 * in `browser-vm/worker/worker.py`: the payload's keys and their order are
 * part of the signed bytes, so both sides must write them the same way.
 *
 * `generation` fences a controller that lost its lease: the worker refuses a
 * token older than the newest generation it has seen. `session` scopes a URL
 * that carries the token in its path — a CDP endpoint or a file download — to
 * one errand's session, or to one keep-alive tab (`b:<targetId>`), since
 * such a URL may be handed to code that should reach nothing else.
 */
export function signBrowserVmToken(input: {
  readonly generation: number;
  readonly session?: string;
  readonly ttlSeconds?: number;
  readonly workspaceId: string;
}) {
  const ttlSeconds = input.ttlSeconds ?? 300;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > maximumTokenSeconds
  ) {
    throw new Error(
      `A browser VM token lives 1 to ${String(maximumTokenSeconds)} seconds.`
    );
  }
  const exp = Math.floor(Date.now() / 1_000) + ttlSeconds;
  // Written in this order, `ses` last and only when given.
  const claims =
    input.session === undefined
      ? { env: input.workspaceId, gen: input.generation, exp }
      : {
          env: input.workspaceId,
          gen: input.generation,
          exp,
          ses: input.session,
        };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signed = `v1.${payload}`;
  const signature = createHmac("sha256", browserVmKey(input.workspaceId))
    .update(signed)
    .digest("base64url");
  return `${signed}.${signature}`;
}

/**
 * The user data a new VM boots with: the worker's environment id and key,
 * readable by the worker alone. The Compute API takes it base64-encoded,
 * which is the caller's step (`agent/lib/browser-vm/cloudru.ts`).
 */
export function browserVmCloudInit(input: { readonly workspaceId: string }) {
  const config = JSON.stringify({
    environment: input.workspaceId,
    key: browserVmKey(input.workspaceId).toString("hex"),
  });
  return [
    "#cloud-config",
    "write_files:",
    "  - path: /etc/bro/worker.json",
    "    owner: bro:bro",
    '    permissions: "0600"',
    // A single-quoted YAML scalar keeps the JSON as written; a quote inside
    // one is written twice.
    `    content: '${config.replaceAll("'", "''")}'`,
    "runcmd:",
    "  - [systemctl, restart, bro-worker]",
    "",
  ].join("\n");
}
