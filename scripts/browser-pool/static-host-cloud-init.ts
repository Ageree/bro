import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";

/**
 * Prints the cloud-init user data a static host of the browser pool is
 * provisioned with (BROWSER_HOST_CLOUD=static, `browserHostCloudInit` in
 * `agent/lib/browser-pool/hosts.ts`): the same document a Cloud.ru host
 * boots with, for the host id listed in BROWSER_HOST_STATIC.
 *
 *   node --env-file-if-exists=.env.local --experimental-transform-types \
 *     scripts/browser-pool/static-host-cloud-init.ts <host id>
 *
 * `--experimental-transform-types`, not strip-only: the application graph it
 * loads (`hosts.ts` and what it imports) uses TypeScript parameter properties.
 *
 * It needs the app's environment (BROWSER_HOST_BUNDLE, BROWSER_SANDBOX_ROOTFS,
 * BROWSER_VM_SIGNING_KEY, the Object Storage keys that presign the bundle
 * and root). The presigned URLs in it are good for an hour and the document
 * holds the host's token key: put it on the server at once, and do not keep
 * the output.
 */
const hostId = process.argv[2];
if (hostId === undefined || process.argv.length > 3) {
  process.stderr.write(
    "Usage: static-host-cloud-init.ts <host id>  (the id listed in BROWSER_HOST_STATIC)\n"
  );
  process.exit(2);
}

registerApplicationModuleResolution();
const { browserHostCloudInit } =
  await import("../../agent/lib/browser-pool/hosts.ts");
process.stdout.write(browserHostCloudInit(hostId));
