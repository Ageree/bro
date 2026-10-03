import { readWorkspaceScope } from "@db/services/scope";
import { readAccountEmail } from "@db/services/users";

/**
 * Whether a pilot list (BROWSER_VM_WORKSPACES and its kin) names the
 * workspace by its id or its owner's email. The email is looked up only when
 * the list has one. `userId` spares the membership lookup when the caller has
 * the scope: the workspace is personal, so its user is its owner.
 */
export async function listsWorkspace(
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
 * How long a workspace's verdict by its owner's email holds for a check
 * that runs at every step: without it a pilot named by email paid a lookup
 * of the email at each one.
 */
const verdictLifetimeMs = 10 * 60_000;

const verdicts = new Map<
  string,
  { readonly expiresAt: number; readonly listed: boolean }
>();

/**
 * `listsWorkspace` for a pilot asked at every step (STEP_CONTEXT_WORKSPACES,
 * SANDBOX_WORKSPACES): a verdict by the owner's email is remembered per list
 * and workspace for ten minutes. A failed lookup throws and is not
 * remembered.
 */
export async function listsWorkspaceRemembered(
  entries: readonly string[] | undefined,
  scope: { readonly userId?: string; readonly workspaceId: string }
) {
  const list = entries ?? [];
  if (list.includes(scope.workspaceId)) return true;
  if (!list.some((entry) => entry.includes("@"))) return false;
  const key = `${list.join(",")}\n${scope.workspaceId}`;
  const now = Date.now();
  const known = verdicts.get(key);
  if (known && known.expiresAt > now) return known.listed;
  const listed = await listsWorkspace(list, scope);
  verdicts.set(key, { expiresAt: now + verdictLifetimeMs, listed });
  return listed;
}

/** The step a pilot is asked in: its session and turn (`turn-kind/step.ts`). */
interface PilotTurn {
  readonly sessionId: string;
  readonly turnId?: string;
}

/** How many turns and sessions keep their verdicts in one process. */
const rememberedVerdicts = 1000;

const turnVerdicts = new Map<string, Promise<boolean>>();
const sessionVerdicts = new Map<string, boolean>();

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  if (map.size <= rememberedVerdicts) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/**
 * A pilot's verdict, the same for every step of a turn: a pilot that flips
 * between steps changes what the step sends (its notes, its tools) and
 * breaks the prompt cache of the whole turn. `lookup` answers undefined when
 * it failed; the turn then keeps the session's last verdict, or stays out of
 * the pilot. Without a turn id the lookup is asked as it is.
 */
export async function pilotVerdictOfTurn(
  pilot: string,
  turn: PilotTurn | undefined,
  lookup: () => Promise<boolean | undefined>
) {
  if (turn?.turnId === undefined) return (await lookup()) ?? false;
  // eve numbers turns per session (`turn_0`, `turn_1`…), so a turn id alone
  // names a turn of every session in the process.
  const key = `${pilot}\n${turn.sessionId}\n${turn.turnId}`;
  const known = turnVerdicts.get(key);
  if (known) return known;
  const sessionKey = `${pilot}\n${turn.sessionId}`;
  const verdict = lookup().then((found) => {
    if (found === undefined) return sessionVerdicts.get(sessionKey) ?? false;
    remember(sessionVerdicts, sessionKey, found);
    return found;
  });
  remember(turnVerdicts, key, verdict);
  return verdict;
}
