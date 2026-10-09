import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { browserHosts, browserVms, db, liveBrowserSandboxStates } from "@db";

type BrowserHostInsert = typeof browserHosts.$inferInsert;

function leaseFree(now: Date) {
  return or(isNull(browserHosts.leaseUntil), lte(browserHosts.leaseUntil, now));
}

export async function readBrowserHost(id: string) {
  const rows = await db
    .select()
    .from(browserHosts)
    .where(eq(browserHosts.id, id))
    .limit(1);
  return rows[0];
}

/** Every host on record, the oldest first. */
export async function listBrowserHosts() {
  return db
    .select()
    .from(browserHosts)
    .orderBy(asc(browserHosts.createdAt), asc(browserHosts.id));
}

/**
 * Take a free host slot (`<prefix>1` … `<prefix><slots>`, `bro-host-1` by
 * default) as a `creating` record whose lease the caller holds for
 * `leaseMs`, before the VM is asked for: a create whose answer is lost is
 * found again by the record's name, and the primary key keeps two callers
 * from taking one slot, so no more hosts than `slots` are ever made.
 * Undefined when every slot is taken.
 */
export async function claimBrowserHostSlot(
  slots: number,
  now: Date,
  leaseMs: number,
  options: { readonly prefix?: string } = {}
) {
  const prefix = options.prefix ?? "bro-host-";
  const taken = new Set((await listBrowserHosts()).map((host) => host.id));
  // A slot past a lowered limit, or of another prefix, still counts: no
  // more hosts than `slots`.
  if (taken.size >= slots) return undefined;
  for (let slot = 1; slot <= slots; slot += 1) {
    // The id is also the VM's name.
    const id = `${prefix}${String(slot)}`;
    if (taken.has(id)) continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- The next slot is tried only when a concurrent caller took this one.
    const [row] = await db
      .insert(browserHosts)
      .values({
        id,
        leaseUntil: new Date(now.getTime() + leaseMs),
        state: "creating",
        stateChangedAt: now,
        vmName: id,
      })
      .onConflictDoNothing({ target: browserHosts.id })
      .returning();
    if (row) return row;
  }
  return undefined;
}

/**
 * Record a host an operator provisioned (`BROWSER_HOST_CLOUD=static`) as
 * `booting`, unless its record exists: no VM, no floating IP, the address
 * given. Undefined when the record is already there.
 */
export async function insertStaticBrowserHost(
  host: {
    readonly address: string;
    readonly bootConfig: string | null;
    readonly id: string;
  },
  now: Date
) {
  const [row] = await db
    .insert(browserHosts)
    .values({
      address: host.address,
      bootConfig: host.bootConfig,
      id: host.id,
      state: "booting",
      stateChangedAt: now,
      vmName: host.id,
    })
    .onConflictDoNothing({ target: browserHosts.id })
    .returning();
  return row;
}

/**
 * Claim the right to create, check or delete the host for `leaseMs`, as
 * `claimBrowserVmLease` does for a workspace's VM. The row as claimed, or
 * undefined when another caller holds a live lease (or there is no record).
 */
export async function claimBrowserHostLease(
  id: string,
  now: Date,
  leaseMs: number
) {
  const [row] = await db
    .update(browserHosts)
    .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
    .where(and(eq(browserHosts.id, id), leaseFree(now)))
    .returning();
  return row;
}

/** Give the lease back; with `leaseUntil`, only that claim of it. */
export async function releaseBrowserHostLease(id: string, leaseUntil?: Date) {
  await db
    .update(browserHosts)
    .set({ leaseUntil: null })
    .where(
      and(
        eq(browserHosts.id, id),
        leaseUntil === undefined
          ? undefined
          : eq(browserHosts.leaseUntil, leaseUntil)
      )
    );
}

/**
 * Write any of the record's columns, as `updateBrowserVm` does: a new state
 * restamps `state_changed_at`, and with `leaseUntil` the write lands only
 * while that claim still holds the lease (it throws otherwise).
 */
export async function updateBrowserHost(
  id: string,
  patch: Partial<
    Omit<BrowserHostInsert, "createdAt" | "id" | "stateChangedAt" | "updatedAt">
  >,
  now = new Date(),
  leaseUntil?: Date
) {
  const nextState = patch.state ?? null;
  const [row] = await db
    .update(browserHosts)
    .set({
      ...patch,
      stateChangedAt: sql`CASE WHEN ${nextState}::text IS NULL OR ${nextState}::text = ${browserHosts.state} THEN ${browserHosts.stateChangedAt} ELSE ${now.toISOString()}::timestamptz END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserHosts.id, id),
        leaseUntil === undefined
          ? undefined
          : eq(browserHosts.leaseUntil, leaseUntil)
      )
    )
    .returning();
  if (row) return row;
  throw new Error(
    leaseUntil === undefined
      ? "The browser host record is gone."
      : "The browser host record is gone, or another step took its lease."
  );
}

/**
 * Remove the host's record once Cloud.ru no longer has its VM. Workspaces
 * that pointed at it keep their sets; their `host_id` goes null.
 */
export async function deleteBrowserHostRecord(id: string) {
  await db.delete(browserHosts).where(eq(browserHosts.id, id));
}

/**
 * How many workspaces Bro has on the host with a live sandbox — starting,
 * running, parking or restoring. A host at none may be deleted once idle.
 */
export async function countLiveSandboxesOnHost(hostId: string) {
  const [row] = await db
    .select({ live: count() })
    .from(browserVms)
    .where(
      and(
        eq(browserVms.hostId, hostId),
        inArray(browserVms.sandboxState, [...liveBrowserSandboxStates])
      )
    );
  return row?.live ?? 0;
}
