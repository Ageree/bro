import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * A site's read operation a browser run of the workspace found behind the
 * options it reported (`site_operations` in browser-vm/worker/worker.py):
 * the results page as a template, where its data comes from, and where the
 * options are in it — `SiteOperation` (`agent/lib/browser-use/site-ops/`),
 * never a value, a cookie, a header or a body. The workspace's own errands
 * get it back; another workspace gets it only once runs of two workspaces
 * found it apart, on the very host its errand names
 * (`listSharedBrowserSiteOperations`): a page one person alone sees — a
 * signed-in cabinet, a company's own subdomain — is never found the same by
 * another. One row per workspace and operation; a run that finds it again
 * counts.
 */
export const browserSiteOperations = pgTable(
  "browser_site_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The results page's host and path, as the template writes them. */
    name: text("name").notNull(),
    host: text("host").notNull(),
    operation: jsonb("operation").notNull(),
    /** How many finished runs found it. */
    runs: integer("runs").notNull().default(1),
    /**
     * Reads of it in a row that found its site changed (`health.ts`): reset
     * by a read that gave results or by a run that found it again. A row
     * may hold only this for a reviewed operation (`knownSiteOperations`).
     */
    failures: integer("failures").notNull().default(0),
    failedAt: timestamp("failed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    /** Why the latest of them failed (`siteReadFailures`). */
    lastFailure: text("last_failure"),
    /** How many of Bro's own reads it answered, with no run (`direct.ts`). */
    served: integer("served").notNull().default(0),
    /**
     * The workspace got it from another's (or from a reviewed one): its row
     * began with a read of it, or with a run that read it through op(). Such
     * a row never counts as a find of its own toward sharing it, however
     * often its runs find it again.
     */
    adopted: boolean("adopted").notNull().default(false),
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
      .notNull(),
  },
  (table) => [
    uniqueIndex("browser_site_operations_workspace_name_uidx").on(
      table.workspaceId,
      table.name
    ),
    check(
      "browser_site_operations_name_check",
      sql`char_length(${table.name}) BETWEEN 1 AND 160`
    ),
    check(
      "browser_site_operations_last_failure_check",
      sql`${table.lastFailure} IS NULL OR ${table.lastFailure} IN ('blocked', 'moved', 'no_data', 'empty', 'unanswered', 'failed')`
    ),
  ]
);
