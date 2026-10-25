import { fastBrowserPilot } from "@agent/lib/browser-vm/pilot";
import { listsWorkspace } from "@agent/lib/workspace-list";
import type { browserRuns } from "@db/schema/browser-runs";
import { browserRunTaskOrigin } from "@db/services/browser-runs";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import type { BrowserUseSecretBinding } from "./client";
import { browserSecretAliases } from "./secrets";
import { stagesErrand } from "./staging";

/**
 * Flash mode of the browser-use worker for errands that only search
 * (`tuning.flashMode`, `runTuning` in `agent/lib/browser-vm/runs.ts`): on
 * 04.10 a step took 7.6 s in it against 11.9 s, the RESULT…NEEDS footer in
 * five runs of five; on 01.10 five errands went from 272 s to 175 s. It
 * drops browser-use's own rules and the model's written reasoning, and was
 * never measured on an errand that signs in or stages a checkout, so only an
 * errand with nothing to sign in to, submit, stage or pay gets it, and only
 * its start: a follow-up keeps full mode. Browser Use Cloud ignores it.
 */

type BrowserRunRecord = typeof browserRuns.$inferSelect;

/**
 * Whether the workspace is in the pilot: FLASH_SEARCH_WORKSPACES names it by
 * workspace id or owner's email, as BROWSER_VM_WORKSPACES does, or everyone
 * with `*`; the fast browser's pilot (`fastBrowserPilot`) brings flash mode
 * along. Unset, nobody is, and nothing is looked up. A failed lookup of the
 * email keeps the errand in full mode rather than failing its start.
 */
export async function flashSearchPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  const list = env.FLASH_SEARCH_WORKSPACES ?? [];
  if (list.includes("*")) return true;
  if (list.length > 0) {
    try {
      if (await listsWorkspace(list, scope)) return true;
    } catch (error) {
      console.warn("[flash-search] pilot lookup failed", { cause: error });
    }
  }
  return fastBrowserPilot(scope);
}

/**
 * Whether an errand starts in flash mode: the person allowed it neither to
 * submit nor to pay (no consent of any kind), it is not to be done but only
 * found (no staging), no secret is bound to it (no sign-in, no card), and
 * the workspace is in the pilot.
 */
export async function errandSearches(
  scope: AccessScope,
  errand: {
    readonly bindings: readonly BrowserUseSecretBinding[];
    readonly paymentAllowed: boolean;
    readonly staged: boolean;
    readonly submits: boolean;
  }
) {
  if (
    errand.submits ||
    errand.paymentAllowed ||
    errand.staged ||
    errand.bindings.length > 0
  ) {
    return false;
  }
  return flashSearchPilot(scope);
}

/**
 * The secrets that only sign a run in to the errand's own site: a saved login
 * and the person's phone. Госуслуги's login is not one of them — signing in
 * there hands a site the person's profile — nor is a card.
 */
const signInAliases: ReadonlySet<string> = new Set([
  browserSecretAliases.loginPassword,
  browserSecretAliases.loginPhoneDigits,
  browserSecretAliases.loginUsername,
  browserSecretAliases.signinPhone,
  browserSecretAliases.signinPhoneDigits,
]);

/**
 * Whether an errand only finds things, whatever it may sign in with: nothing
 * allowed in the person's name, nothing to pay or stage, and no secret bound
 * but a sign-in on its own site. The code engine takes such a start
 * (`errandEngine`): on the owner's account every errand with a site binds
 * their phone or a saved login (`resolveBrowserSecretBindings`), so `search`,
 * which takes none, never reached it (25.10). Flash mode stays with `search`:
 * it was never measured on a run that signs in.
 */
export function errandFindsOnly(errand: {
  readonly bindings: readonly BrowserUseSecretBinding[];
  readonly paymentAllowed: boolean;
  readonly staged: boolean;
  readonly submits: boolean;
}) {
  return (
    !errand.submits &&
    !errand.paymentAllowed &&
    !errand.staged &&
    errand.bindings.every((binding) => signInAliases.has(binding.alias))
  );
}

/**
 * The same for a queued start or an anti-bot retry, decided again from what
 * the errand's row keeps, never carried over from an earlier start: no
 * payment allowed, no submission confirmed, no staging in the composed task,
 * no secret bound now, the pilot on — and the errand's own start, through
 * its retries and its queued start, never a follow-up (`browserRunTaskOrigin`),
 * which keeps full mode wherever it runs; `findsOnly` likewise, for the code
 * engine. A lookup that fails keeps full mode and browser-use.
 */
export async function storedErrandSearches(
  row: Pick<
    BrowserRunRecord,
    | "createdByUserId"
    | "id"
    | "paymentAllowed"
    | "submission"
    | "task"
    | "workspaceId"
  >,
  composedTask: string,
  bindings: readonly BrowserUseSecretBinding[]
) {
  const scope = { userId: row.createdByUserId, workspaceId: row.workspaceId };
  const errand = {
    bindings,
    paymentAllowed: row.paymentAllowed,
    staged: stagesErrand(composedTask),
    submits: row.submission !== null,
  };
  const searches = await errandSearches(scope, errand);
  // Only where the code engine has a pilot at all: unset, nothing is read.
  const findsOnly =
    (env.BROWSER_CODE_ENGINE_WORKSPACES ?? []).length > 0 &&
    errandFindsOnly(errand);
  if (!searches && !findsOnly) return { findsOnly: false, search: false };
  try {
    const start = (await browserRunTaskOrigin(scope, row)) === "start";
    return { findsOnly: findsOnly && start, search: searches && start };
  } catch (error) {
    console.warn("[flash-search] the errand's origin could not be read", {
      cause: error,
      runId: row.id,
    });
    return { findsOnly: false, search: false };
  }
}
