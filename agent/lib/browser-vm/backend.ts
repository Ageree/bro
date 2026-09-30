import { readWorkspaceScope } from "@db/services/scope";
import { readAccountEmail } from "@db/services/users";
import { env } from "@shared/environment";

/**
 * Whether this deployment can run browser errands on Cloud.ru VMs at all:
 * the Cloud.ru key to create and power them, the sealed image, the key their
 * workers' tokens derive from, the residential proxy that is their only way
 * out, and the model key their agent runs on.
 */
export function browserVmConfigured() {
  return (
    env.CLOUDRU_KEY_ID !== undefined &&
    env.CLOUDRU_KEY_SECRET !== undefined &&
    env.CLOUDRU_BROWSER_IMAGE !== undefined &&
    env.BROWSER_VM_SIGNING_KEY !== undefined &&
    env.BROWSER_VM_PROXY !== undefined &&
    env.BROWSER_VM_LLM_API_KEY !== undefined
  );
}

/**
 * Whether this deployment can run browsers as sandboxes of the pool
 * (docs/browser-pool.md): the Cloud.ru key for the hosts and, with the
 * tenant, for Object Storage; the bucket and the key the sets are sealed
 * with; the host code and the sandbox root; the runtime, BROWSER_HOST_RUNTIME
 * `runc` named outright or the pinned gVisor release (`runsc`, which an unset
 * runtime means, as before that setting, so a deployment gains no pool and
 * no new runtime from it); and the VM backend's own signing key, proxy
 * and model key, since a sandbox runs the same worker. The VM image is not
 * needed: hosts boot stock Ubuntu.
 */
export function browserPoolConfigured() {
  return (
    browserStateConfigured() &&
    env.BROWSER_HOST_BUNDLE !== undefined &&
    (env.BROWSER_HOST_RUNTIME === "runc" ||
      env.BROWSER_HOST_RUNSC_RELEASE !== undefined) &&
    env.BROWSER_SANDBOX_ROOTFS !== undefined &&
    env.BROWSER_VM_SIGNING_KEY !== undefined &&
    env.BROWSER_VM_PROXY !== undefined &&
    env.BROWSER_VM_LLM_API_KEY !== undefined
  );
}

/**
 * Whether sandboxes can be parked into sets and restored from them: the
 * Cloud.ru key with its Object Storage tenant, the bucket, and the key the
 * sets are sealed with. Less than `browserPoolConfigured`, which new
 * sandboxes need: the pool's hosts are looked after, and their sandboxes
 * parked, with only this and the host token key (`reconcileBrowserPool`).
 */
export function browserStateConfigured() {
  return (
    env.CLOUDRU_KEY_ID !== undefined &&
    env.CLOUDRU_KEY_SECRET !== undefined &&
    env.CLOUDRU_S3_TENANT_ID !== undefined &&
    env.BROWSER_STATE_BUCKET !== undefined &&
    env.BROWSER_STATE_KEY !== undefined
  );
}

/**
 * Whether a workspace's browser is a sandbox of the pool: every workspace
 * once BROWSER_BACKEND is `pool`, and before that the pilot's, named in
 * BROWSER_POOL_WORKSPACES as in BROWSER_VM_WORKSPACES. Without the pool's
 * settings nobody's is, and nothing is looked up.
 */
export async function usesBrowserPool(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  if (!browserPoolConfigured()) return false;
  if (env.BROWSER_BACKEND === "pool") return true;
  return listed(env.BROWSER_POOL_WORKSPACES, scope);
}

/**
 * Whether a workspace's errands run on its own browser rather than on
 * Browser Use Cloud. A pool workspace's do (its sandbox runs the same worker
 * with the same ids and tokens); otherwise every workspace's once
 * BROWSER_BACKEND is `cloudru`, and before that the pilot's, named in
 * BROWSER_VM_WORKSPACES by workspace id or by the owner's email, on its own
 * Cloud.ru VM. Read afresh on every call, so a change to a list takes effect
 * with the next errand.
 *
 * `userId` spares the membership lookup when the caller has the scope; the
 * workspace is personal, so its user is its owner.
 */
export async function usesBrowserVm(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  if (await usesBrowserPool(scope)) return true;
  if (!browserVmConfigured()) return false;
  if (env.BROWSER_BACKEND === "cloudru") return true;
  return listed(env.BROWSER_VM_WORKSPACES, scope);
}

/** Whether a pilot list names the workspace by its id or its owner's email. */
async function listed(
  entries: readonly string[] | undefined,
  scope: { readonly userId?: string; readonly workspaceId: string }
) {
  const list = entries ?? [];
  if (list.includes(scope.workspaceId)) return true;
  const emails = list
    .filter((entry) => entry.includes("@"))
    .map((entry) => entry.toLowerCase());
  if (emails.length === 0) return false;
  const userId =
    scope.userId ?? (await readWorkspaceScope(scope.workspaceId))?.userId;
  if (userId === undefined) return false;
  const email = await readAccountEmail({
    userId,
    workspaceId: scope.workspaceId,
  });
  return email !== undefined && emails.includes(email.toLowerCase());
}

/**
 * The model the VM's agent runs on. It goes with every run and follow-up,
 * since the VM keeps no key on its disk.
 */
/** The 2Captcha key a run takes to its worker, when this deployment has one. */
export function browserVmCaptcha() {
  const twoCaptchaKey = env.BROWSER_VM_TWOCAPTCHA_API_KEY;
  return twoCaptchaKey === undefined ? undefined : { twoCaptchaKey };
}

export function browserVmLlm() {
  const apiKey = env.BROWSER_VM_LLM_API_KEY;
  if (apiKey === undefined) {
    throw new Error("BROWSER_VM_LLM_API_KEY is not configured.");
  }
  return {
    apiKey,
    baseUrl: env.BROWSER_VM_LLM_BASE_URL,
    model: env.BROWSER_VM_MODEL,
  };
}
