import { isSharedPrincipal, localDevPrincipal } from "./tenant.ts";

/**
 * Supermemory is the ONLY memory Bro has.
 *
 * It used to be optional: no key meant both Supermemory slots quietly resolved
 * their scope to null and the hand-rolled Convex `memo` store carried the day.
 * The memo store is gone, so «optional» would now mean an agent with no memory
 * whatsoever and not one line in the log saying so — it would simply forget
 * everything and sound confident about it. Hence the shape of `assertKey()` in
 * composio.ts: one loud throw at first use, naming the variable and where the
 * key comes from, instead of a silent degrade.
 */
export function supermemoryKey(env: {
  SUPERMEMORY_API_KEY?: string;
} = process.env): string {
  const key = env.SUPERMEMORY_API_KEY?.trim();
  if (!key || key.includes("xxxx") || key.includes("your_")) {
    throw new Error(
      "SUPERMEMORY_API_KEY missing or placeholder. Supermemory is the only memory Bro has — without it every slot is empty and nothing would say so. Set it in .env.local (and on the deployment) from https://console.supermemory.ai, or set BRO_MEMORY_OPTIONAL=1 to run this instance deliberately memoryless.",
    );
  }
  return key;
}

/**
 * Deliberately running without memory — a local session or a CI conversation
 * run, never a deployment serving people.
 *
 * The throw above is right for production and wrong as the only option: it
 * takes every turn down over a key the operator may simply not have bought
 * yet, and it would have made the repo's own live conversation suite
 * impossible to run. So the escape is explicit and has to be typed out, like
 * `BRO_LOCAL_DEV_PRINCIPAL` — nobody falls into it, and «memory is off» is a
 * decision somebody made rather than a silence nobody noticed.
 */
export function memoryOptional(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BRO_MEMORY_OPTIONAL?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

type AuthSide = { principalId?: string | null } | null | undefined;

/**
 * iMessage E.164 for this person, or null (slot disabled) when this turn names
 * no single person. Never from the model.
 *
 * This used to end `return production ? null : "local-dev"`, with `production`
 * meaning `NODE_ENV === "production"` — a variable nothing in this repository
 * ever sets, left to whatever the host happens to default to. Get that wrong
 * once and every person-less turn shares one memory bucket: one set of Convex
 * rows, one `bro_archive_local-dev` container, one conversation container whose
 * captured turns are then recalled verbatim into a stranger's prompt. Same
 * failure `tenantId()` had, so it now takes the same two rules — one shared
 * predicate, and an escape that has to be typed out by name.
 */
export function resolveMemoryScope(auth: {
  current?: AuthSide;
  initiator?: AuthSide;
}): string | null {
  const id = auth.current?.principalId ?? auth.initiator?.principalId;
  if (typeof id === "string" && !isSharedPrincipal(id)) return id.trim();
  return localDevPrincipal() ?? null;
}

/** The slot scope is a string phone; tuples never occur but must not crash. */
export function scopePhone(value: string | readonly string[]): string {
  return typeof value === "string" ? value : value.join("/");
}

/**
 * The scope a Supermemory slot locks to for this turn, or null when the caller
 * is not a single identifiable person. The key check runs FIRST and on every
 * turn: a slot that silently disabled itself is exactly the failure this
 * collapse to one memory backend must never reintroduce.
 */
export function resolveSupermemoryScope(auth: {
  current?: AuthSide;
  initiator?: AuthSide;
}): string | null {
  if (memoryOptional()) return null;
  supermemoryKey();
  return resolveMemoryScope(auth);
}
