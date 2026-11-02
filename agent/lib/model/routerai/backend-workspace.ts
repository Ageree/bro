import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModelMiddleware } from "ai";
import { env } from "@shared/environment";

/**
 * The workspace whose step a model call belongs to, set by
 * `backendWorkspaceMiddleware`: the cheaper backends (`compatible.ts`) are a
 * pilot by workspace, and the fetch they sit in has no other way to know it.
 */
const callWorkspace = new AsyncLocalStorage<string>();

/** Runs `call` as a step of `workspaceId`'s. */
export function runAsBackendWorkspace<T>(workspaceId: string, call: () => T) {
  return callWorkspace.run(workspaceId, call);
}

/** Marks the model calls of a step as `workspaceId`'s. */
export function backendWorkspaceMiddleware(
  workspaceId: string
): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate }) =>
      runAsBackendWorkspace(workspaceId, doGenerate),
    wrapStream: async ({ doStream }) =>
      runAsBackendWorkspace(workspaceId, doStream),
  };
}

/**
 * Whether a backend's list (`*` or workspace ids; none for nobody) covers the
 * current call: `*` covers every call, an id only the steps marked as that
 * workspace's.
 */
export function backendCoversCall(list: readonly string[] | undefined) {
  if (list === undefined) return false;
  if (list.includes("*")) return true;
  const workspaceId = callWorkspace.getStore();
  return workspaceId !== undefined && list.includes(workspaceId);
}

/**
 * Whether a workspace is named by id in a cheaper backend's pilot list, so
 * its steps need the mark: `*` covers every call without one, and with no
 * list the options of a step stay as they were.
 */
export function namedInBackendPilot(workspaceId: string) {
  return [env.ORCAROUTER_WORKSPACES, env.BEATAPI_WORKSPACES].some((list) =>
    list?.includes(workspaceId)
  );
}
