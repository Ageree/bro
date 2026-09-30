import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * Where a workspace's browser VM is in its life. `stopped` with no `vm_id`
 * is a workspace that has no VM yet: the first errand creates one.
 */
export const browserVmStates = [
  "creating",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "deleting",
  "failed",
] as const;

/**
 * A VM run as Bro knows it. `dispatching` is Bro's own step between
 * recording the run and the worker accepting it; the rest are the worker's.
 */
export const browserVmRunStatuses = [
  "queued",
  "dispatching",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

/** The statuses a VM run never leaves once it reaches one. */
export const settledBrowserVmRunStatuses = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly (typeof browserVmRunStatuses)[number][];

/**
 * The address the residential proxy last gave the workspace's browser, as
 * the worker saw it from the VM. A shop judges the person by it, so an exit
 * outside Russia is rotated before any errand starts.
 */
interface BrowserVmProxyExit {
  readonly ip: string;
  readonly city: string | null;
  readonly country: string | null;
  readonly org: string | null;
  /** When the exit was checked, as an ISO time: an old check is redone. */
  readonly at: string;
}

/**
 * The Cloud.ru VM that holds one workspace's browser and its profile. The
 * disk is the profile: sign-ins live in the Chrome profile on it, so a VM
 * that already served is stopped when idle and started again, never
 * replaced. Every lifecycle step runs under `lease_until`, because an
 * errand, the poller's reconcile and a deletion may all reach for one VM.
 */
export const browserVms = pgTable(
  "browser_vms",
  {
    // Restrict, not cascade: the row is the only record of a VM that is
    // billed until `deleteBrowserVm` removed it, so a workspace cannot be
    // deleted from under it.
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    state: text("state", { enum: browserVmStates }).notNull(),
    vmId: text("vm_id"),
    vmName: text("vm_name"),
    // The VM's public IPv4 address: the worker is reached through it.
    host: text("host"),
    // Kept to delete with the VM: a floating IP left behind stays billed.
    floatingIpId: text("floating_ip_id"),
    bootDiskId: text("boot_disk_id"),
    image: text("image"),
    // Bumped each time a VM is created and signed into every worker token,
    // so a token minted for a replaced VM does not open the new one.
    generation: integer("generation").notNull().default(0),
    // Part of the profile id Bro hands out (`vm:<ws>:p<n>`). Forgetting the
    // sign-ins bumps it, so runs recorded against the old profile read as
    // forgotten.
    profileGeneration: integer("profile_generation").notNull().default(1),
    // The person asked to forget the sign-ins while the VM was off: the
    // profile is reset on the VM as soon as it is up again.
    profileResetPending: boolean("profile_reset_pending")
      .notNull()
      .default(false),
    // The sticky proxy session token, so the workspace keeps one exit
    // address across errands, and a rotated one once that exit went bad.
    proxySession: text("proxy_session"),
    proxyExit: jsonb("proxy_exit").$type<BrowserVmProxyExit>(),
    // When an errand last used the browser: the idle stop counts from it.
    lastUsedAt: timestamp("last_used_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // Null while the VM is on the person's idle window: it stops once
    // unused for `BROWSER_VM_IDLE_MINUTES` since `last_used_at`. Set, the VM
    // is on an errand nobody waits for (a schedule's, a report turn's) or on
    // a page waiting for the person's code, and it stops at this moment,
    // or a short grace after its last use, whichever comes later
    // (`agent/lib/browser-vm/idle.ts`).
    stopNotBefore: timestamp("stop_not_before", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // The watchdog measures a VM that does not come up from here.
    stateChangedAt: timestamp("state_changed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    // A lease, not a state: whoever holds a fresh one is the only caller
    // creating, powering or deleting this VM.
    leaseUntil: timestamp("lease_until", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // When a step last took the lease. The reconcile goes round the records
    // from the one taken longest ago, so VMs it can do nothing about do not
    // keep the rest out of its limit.
    claimedAt: timestamp("claimed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // When a VM that did not come up was given up on and powered off, until
    // it comes up again. Meanwhile only an errand powers it on: the reconcile
    // would otherwise start it over and over to wipe a forgotten profile.
    givenUpAt: timestamp("given_up_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // Reboots the watchdog spent on a VM that did not come up.
    recoveries: integer("recoveries").notNull().default(0),
    // Health checks in a row the worker of a ready VM missed: one slow answer
    // must not take a VM out of service, so the reconcile hands it to the
    // watchdog only after a few.
    healthFailures: integer("health_failures").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "browser_vms_state_check",
      sql`${table.state} IN ('creating', 'starting', 'ready', 'stopping', 'stopped', 'deleting', 'failed')`
    ),
    check("browser_vms_generation_check", sql`${table.generation} >= 0`),
    check(
      "browser_vms_profile_generation_check",
      sql`${table.profileGeneration} >= 1`
    ),
    check("browser_vms_recoveries_check", sql`${table.recoveries} >= 0`),
    check(
      "browser_vms_health_failures_check",
      sql`${table.healthFailures} >= 0`
    ),
    index("browser_vms_reconcile_idx").on(table.state, table.stateChangedAt),
  ]
);

/**
 * Bro's own record of every run on a workspace's VM. While the VM is up the
 * worker is the truth about a run; this row answers when it is off, and it
 * keeps the composed task text that Browser Use used to keep for Bro.
 */
export const browserVmRuns = pgTable(
  "browser_vm_runs",
  {
    // `vm:<workspace>:r:<uuid>`, minted by Bro before the worker sees it, so
    // a dispatch lost on the network is found again by the same id.
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    task: text("task").notNull(),
    status: text("status", { enum: browserVmRunStatuses })
      .notNull()
      .default("queued"),
    result: text("result"),
    error: text("error"),
    finalUrl: text("final_url"),
    // Messages queued into the run (`POST .../messages`, answered `queued`)
    // that the agent never read before it settled. The worker never starts a
    // follow-up run on its own; a poller that finds these on a settled run it
    // still tracks starts the follow-up itself so their outcome is not lost.
    // Absent or empty when there is nothing unread.
    unreadMessages: jsonb("unread_messages").$type<string[]>(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "browser_vm_runs_status_check",
      sql`${table.status} IN ('queued', 'dispatching', 'running', 'completed', 'failed', 'cancelled')`
    ),
    index("browser_vm_runs_workspace_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
    index("browser_vm_runs_session_idx").on(
      table.sessionId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);
