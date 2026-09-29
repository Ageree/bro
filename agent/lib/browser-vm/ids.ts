import { randomUUID } from "node:crypto";

/**
 * Ids of the Cloud.ru browser VM backend. Every id Bro keeps for a VM errand —
 * the profile on `browser_profiles`, the session and run on `browser_runs`, a
 * keep-alive browser — starts with `vm:` and names its workspace, so
 * `agent/lib/browser-use/client.ts` sends it to the right backend and to the
 * right VM (one per workspace) from the id alone. Browser Use ids are UUIDs,
 * which never start that way.
 *
 * A workspace id holds colons itself (`personal:<hash>`), so an id is read
 * from its end: the last part is `p<generation>`, or a kind letter and a
 * value that has no colon (a UUID, a Chrome target id).
 */
const prefix = "vm:";

const idPattern =
  /^vm:(?<workspace>.+):(?:p(?<generation>\d+)|(?<kind>[brs]):(?<value>[\w.-]+))$/u;

// What the worker accepts as a run or session id (`safe_id` in
// `browser-vm/worker/worker.py`).
const workerIdPattern = /^[A-Za-z0-9][\w.:-]{0,127}$/u;

export function isBrowserVmId(id: string) {
  return id.startsWith(prefix);
}

/** The workspace, and so the VM, an id belongs to. */
export function browserVmWorkspace(id: string) {
  return parse(id).workspace;
}

/**
 * The profile of a workspace's VM. Forgetting sign-ins bumps the generation,
 * so a run that holds an older profile id reads as forgotten, as a deleted
 * Browser Use profile did.
 */
export function browserVmProfileId(workspaceId: string, generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("A browser VM profile generation is a whole number.");
  }
  return compose(workspaceId, `p${String(generation)}`);
}

export function newBrowserVmSessionId(workspaceId: string) {
  return workerId(compose(workspaceId, `s:${randomUUID()}`));
}

export function newBrowserVmRunId(workspaceId: string) {
  return workerId(compose(workspaceId, `r:${randomUUID()}`));
}

/** A keep-alive visit's blank tab, which stands in for a standalone browser. */
export function browserVmBrowserId(workspaceId: string, targetId: string) {
  return compose(workspaceId, `b:${targetId}`);
}

/** The Chrome target a keep-alive browser id stands for. */
export function browserVmTargetOf(browserId: string) {
  const { kind, value } = parse(browserId);
  if (kind !== "b" || value === undefined) {
    throw new Error(`Not a browser VM browser id: ${browserId}`);
  }
  return value;
}

function compose(workspaceId: string, suffix: string) {
  const id = `${prefix}${workspaceId}:${suffix}`;
  // Built and read back, so an id that would not survive the round trip —
  // an empty workspace, a target id with a colon — is refused here rather
  // than sent to the wrong VM later.
  if (idPattern.exec(id)?.groups?.workspace !== workspaceId) {
    throw new Error(`No browser VM id reads back from ${id}.`);
  }
  return id;
}

function workerId(id: string) {
  if (!workerIdPattern.test(id)) {
    throw new Error(`The browser VM worker would refuse the id ${id}.`);
  }
  return id;
}

function parse(id: string) {
  const groups = idPattern.exec(id)?.groups;
  const workspace = groups?.workspace;
  if (workspace === undefined) {
    throw new Error(`Not a browser VM id: ${id}`);
  }
  return { kind: groups?.kind, value: groups?.value, workspace };
}
