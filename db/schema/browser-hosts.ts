import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Where a host of the browser pool is in its life (docs/browser-pool.md):
 * `creating` until Cloud.ru gave it an address, `booting` while cloud-init
 * sets it up, `ready` to take sandboxes, `draining` when it has been empty
 * for the idle time and takes no new sandbox, `deleting` until Cloud.ru no
 * longer has it, `failed` when it stopped answering or never came up.
 */
export const browserHostStates = [
  "creating",
  "booting",
  "ready",
  "draining",
  "deleting",
  "failed",
] as const;

/**
 * What Bro last read of a host's capacity (`GET /v1/capacity` of `hostd`):
 * enough to place a sandbox without asking every host, and to see that it
 * holds none.
 */
interface BrowserHostCapacity {
  /** Memory the host lets its sandboxes' limits add up to. */
  readonly limitMb: number;
  /** What the limits of the sandboxes it holds add up to. */
  readonly committedMb: number;
  /** Sandboxes the host holds that are not parked. */
  readonly sandboxes: number;
  readonly rootfsVersions: readonly string[];
  /** `runsc --version` of the host: part of every snapshot's format. */
  readonly runsc: string | null;
  /** `runc` or `runsc`; absent from what an older `hostd` reported. */
  readonly runtime?: string | null;
}

/**
 * A Cloud.ru VM that runs people's browsers as sandboxes (plain `runc`
 * containers, or gVisor). It holds
 * nobody's data for longer than a sandbox lives there, so a host is created
 * when a sandbox needs room and deleted once it has been empty for a while.
 * The id is also the VM's name and the host's identity in its token key
 * (`agent/lib/browser-pool/keys.ts`); ids are the slots `bro-host-1` to
 * `bro-host-<BROWSER_HOST_MAX>` (BROWSER_HOST_NAME_PREFIX, for a test stand,
 * names them otherwise), so the primary key alone keeps two callers
 * from creating more hosts than the quota holds. Every lifecycle step runs
 * under `lease_until`, as for `browser_vms`.
 */
export const browserHosts = pgTable(
  "browser_hosts",
  {
    id: text("id").primaryKey(),
    state: text("state", { enum: browserHostStates }).notNull(),
    vmId: text("vm_id"),
    vmName: text("vm_name").notNull(),
    // The public IPv4 address: Caddy on it answers for `hostd` and every
    // sandbox's worker.
    address: text("address"),
    // Deleted with the VM: a floating IP left behind stays billed.
    floatingIpId: text("floating_ip_id"),
    capacity: jsonb("capacity").$type<BrowserHostCapacity>(),
    // When `hostd` last answered: a ready host silent for long is failed.
    lastSeenAt: timestamp("last_seen_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // Since when the host holds no live sandbox; the idle deletion counts
    // from here. Null while it holds one.
    emptySince: timestamp("empty_since", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    lastError: text("last_error"),
    // When a booting host that never answered was rebooted: a first boot
    // may hang in `(initramfs)`, and a reboot cures it. Only once.
    rebootedAt: timestamp("rebooted_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // Set when the host failed before it was ready: its record outlives its
    // VM until then, holding its slot, so a boot that fails every time
    // (a wrong bundle, root or mirror) does not create, bill and delete a
    // host in a loop.
    createBlockedUntil: timestamp("create_blocked_until", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // A lease, not a state: whoever holds a fresh one is the only caller
    // creating, checking or deleting this host.
    leaseUntil: timestamp("lease_until", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // The watchdog measures a host that does not come up from here.
    stateChangedAt: timestamp("state_changed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
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
      "browser_hosts_state_check",
      sql`${table.state} IN ('creating', 'booting', 'ready', 'draining', 'deleting', 'failed')`
    ),
    check("browser_hosts_id_check", sql`${table.id} ~ '^[a-z0-9-]{1,63}$'`),
    index("browser_hosts_state_idx").on(table.state, table.stateChangedAt),
  ]
);
