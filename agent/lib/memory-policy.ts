/** Principals that would mix people in one memory bucket. */
const SHARED = new Set(["", "unknown", "default", "eve:app"]);

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
      "SUPERMEMORY_API_KEY missing or placeholder. Supermemory is the only memory Bro has — without it every slot is empty and nothing would say so. Set it in .env.local (and on the deployment) from https://console.supermemory.ai.",
    );
  }
  return key;
}

type AuthSide = { principalId?: string | null } | null | undefined;

/**
 * iMessage E.164 for this person, `local-dev` outside production, or null
 * (slot disabled) when the caller could mix people. Never from the model.
 */
export function resolveMemoryScope(
  auth: { current?: AuthSide; initiator?: AuthSide },
  production: boolean,
): string | null {
  const id = auth.current?.principalId ?? auth.initiator?.principalId;
  if (typeof id === "string" && !SHARED.has(id)) return id;
  return production ? null : "local-dev";
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
export function resolveSupermemoryScope(
  auth: { current?: AuthSide; initiator?: AuthSide },
  production: boolean,
): string | null {
  supermemoryKey();
  return resolveMemoryScope(auth, production);
}
