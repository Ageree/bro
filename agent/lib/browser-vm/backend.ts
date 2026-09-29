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
 * Whether a workspace's errands run on its own Cloud.ru VM rather than on
 * Browser Use Cloud: every workspace once BROWSER_BACKEND is `cloudru`, and
 * before that the pilot's, named in BROWSER_VM_WORKSPACES by workspace id or
 * by the owner's email. Read afresh on every call, so a change to the list
 * takes effect with the next errand.
 *
 * `userId` spares the membership lookup when the caller has the scope; the
 * workspace is personal, so its user is its owner.
 */
export async function usesBrowserVm(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  if (!browserVmConfigured()) return false;
  if (env.BROWSER_BACKEND === "cloudru") return true;
  const listed = env.BROWSER_VM_WORKSPACES ?? [];
  if (listed.includes(scope.workspaceId)) return true;
  const emails = listed
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
