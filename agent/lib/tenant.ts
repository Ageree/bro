export { chatConversationId } from "../../convex/lib/tenantConversation.ts";

const LOCAL = "local-dev";

/**
 * Principal ids that name no single person.
 *
 * `local-dev` belongs in here and did not use to be. `tenantId()` returned it
 * as a silent fallback for any turn whose auth carried no principal, and
 * nothing downstream rejected it: `requireUserId` in `lib/composio.ts` listed
 * the other three and not this one, so every such turn on the deployment
 * shared ONE Composio user named `local-dev` — one Gmail connection, one
 * calendar, one set of triggers. The same string was also the tenant key for
 * jobs, wakeups, orders and the open-job list pasted into the system prompt,
 * so one person's parked work was read back to another person. One set, one
 * predicate, used by everything that turns a principal into a tenant key.
 */
const SHARED = new Set(["", "unknown", "default", "eve:app", LOCAL]);

type AuthBox = {
  session: {
    auth: {
      current?: { principalId?: string | null } | null;
      initiator?: { principalId?: string | null } | null;
    };
  };
};

/** True for a principal that would mix people if used as a tenant key. */
export function isSharedPrincipal(id: string | null | undefined): boolean {
  return typeof id !== "string" || SHARED.has(id.trim());
}

/**
 * The principal an explicitly configured local session stands in as, if any.
 *
 * One escape hatch for the whole agent, so the tenant key and the memory scope
 * cannot disagree about who this turn belongs to. It refuses a shared value,
 * which is the entire point: the hole this replaces was a *default* nobody
 * typed, and a default is what let two people meet in one bucket.
 */
export function localDevPrincipal(): string | undefined {
  const local = process.env.BRO_LOCAL_DEV_PRINCIPAL?.trim();
  return local && !isSharedPrincipal(local) ? local : undefined;
}

function principalOf(ctx: AuthBox): string | undefined {
  const id =
    ctx.session.auth.current?.principalId ??
    ctx.session.auth.initiator?.principalId;
  return typeof id === "string" ? id.trim() : undefined;
}

/**
 * This person's iMessage/Telegram E.164. Never from the model.
 *
 * Throws instead of falling back to a shared bucket. Every production entry
 * point stamps a principal (Photon inbound, Telegram inbound, `/internal/wakeup`
 * and inbound mail all pass `principalId` from server-side state), so a missing
 * one means the turn has no person attached and must fail rather than guess.
 * For a local TUI session set `BRO_LOCAL_DEV_PRINCIPAL` to your own number —
 * an explicit opt-in that cannot happen by accident on a deployment.
 */
export function tenantId(ctx: AuthBox): string {
  const id = principalOf(ctx);
  if (id !== undefined && !isSharedPrincipal(id)) return id;
  const local = localDevPrincipal();
  if (local) return local;
  throw new Error(
    "refusing shared principal: this turn carries no person. " +
      "Set BRO_LOCAL_DEV_PRINCIPAL for a local session.",
  );
}

/** Composio user id for this person. Throws on shared buckets. */
export function composioUserId(principal: string): string {
  const id = principal.trim();
  if (isSharedPrincipal(id)) {
    throw new Error("refusing shared Composio user id");
  }
  return id;
}

/** Personal iMessage/Telegram phone. Throws on the same shared buckets. */
export function requirePersonalPhone(principal: string): string {
  const id = principal.trim();
  if (isSharedPrincipal(id)) {
    throw new Error("refusing shared principal");
  }
  return id;
}
